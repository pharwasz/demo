import {
  TransactionBuilder,
  Account,
  Contract,
  nativeToScVal,
  Address,
  xdr,
  scValToNative,
} from '@stellar/stellar-sdk';
import { STELLAR_NETWORK } from '@/config';

// Wraith Names contract ID on Stellar Testnet
// TODO: Replace with actual contract ID from deployment
export const NAMES_CONTRACT_ID = 'CD3Z7J2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL';

export interface NameMetadata {
  avatar_url?: string;
  twitter_handle?: string;
  description?: string;
  socials?: Record<string, string>;
}

export interface NameRecord {
  name: string;
  owner: string;
  expires_at: number;
  metadata: NameMetadata;
}

export interface RegistrationParams {
  name: string;
  duration: number; // in seconds
}

export interface TransferParams {
  name: string;
  to: string;
}

export interface RenewParams {
  name: string;
  duration: number; // in seconds
}

export interface MetadataParams {
  name: string;
  metadata: NameMetadata;
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    const text = value.toString();
    return text && text !== '[object Object]' ? text : undefined;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeMetadataValue(value: unknown): NameMetadata {
  if (!value || typeof value !== 'object') return {};

  if (value instanceof Map) {
    const entries = Object.fromEntries(
      Array.from(value.entries()).map(([key, entryValue]) => [String(key), entryValue]),
    );
    return normalizeMetadataValue(entries);
  }

  const record = value as Record<string, unknown>;
  const direct = record.metadata ?? record.meta ?? record.attributes ?? record;
  const values = direct && typeof direct === 'object' ? (direct as Record<string, unknown>) : {};

  const metadata: NameMetadata = {};
  const fallbackValues = Object.entries(values).reduce<Record<string, unknown>>(
    (acc, [key, entryValue]) => {
      if (
        typeof entryValue === 'object' &&
        entryValue &&
        'key' in entryValue &&
        'value' in entryValue
      ) {
        acc[String((entryValue as { key?: unknown }).key)] = (
          entryValue as { value?: unknown }
        ).value;
        return acc;
      }
      acc[key] = entryValue;
      return acc;
    },
    {},
  );

  const avatarUrl = asString(
    fallbackValues.avatar_url ?? fallbackValues.avatarUrl ?? fallbackValues.avatar,
  );
  const twitterHandle = asString(
    fallbackValues.twitter_handle ?? fallbackValues.twitterHandle ?? fallbackValues.twitter,
  );
  const description = asString(
    fallbackValues.description ?? fallbackValues.bio ?? fallbackValues.summary,
  );
  const socials =
    typeof fallbackValues.socials === 'object' && fallbackValues.socials
      ? (fallbackValues.socials as Record<string, unknown>)
      : undefined;

  if (avatarUrl) metadata.avatar_url = avatarUrl;
  if (twitterHandle) metadata.twitter_handle = twitterHandle;
  if (description) metadata.description = description;
  if (socials) {
    metadata.socials = Object.fromEntries(
      Object.entries(socials)
        .filter(([, v]) => typeof v !== 'undefined' && v !== null)
        .map(([key, v]) => [key, asString(v) ?? String(v)]),
    );
  }

  return metadata;
}

function normalizeNameRecordResult(value: unknown, fallbackName: string): NameRecord | null {
  if (value === null || value === undefined || value === false) return null;

  const root = (() => {
    if (typeof value === 'object' && value && 'record' in value)
      return (value as { record: unknown }).record;
    if (typeof value === 'object' && value && 'result' in value)
      return (value as { result: unknown }).result;
    return value;
  })();

  if (!root || typeof root !== 'object') {
    if (typeof root === 'string' || typeof root === 'number' || typeof root === 'bigint') {
      return null;
    }
    return null;
  }

  const obj = root as Record<string, unknown>;
  const owner = asString(
    obj.owner ??
      obj.owner_address ??
      obj.ownerAddress ??
      obj.address ??
      obj.account ??
      obj.recipient,
  );
  const expiresAt = asNumber(
    obj.expires_at ?? obj.expiresAt ?? obj.expiration ?? obj.expiry ?? obj.expires,
  );

  const metadata = normalizeMetadataValue(obj.metadata ?? obj.meta ?? obj.attributes ?? obj);
  const name = asString(obj.name) || fallbackName;

  if (
    !owner &&
    !expiresAt &&
    !metadata.avatar_url &&
    !metadata.description &&
    !metadata.twitter_handle
  ) {
    if (Array.isArray(root)) {
      const first = root[0];
      if (first && typeof first === 'object') return normalizeNameRecordResult(first, fallbackName);
    }
    return null;
  }

  return {
    name,
    owner: owner || '',
    expires_at: expiresAt ? Math.floor(expiresAt) : 0,
    metadata,
  };
}

function parseSimulationReturnValue(value: unknown, fallbackName: string): NameRecord | null {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseSimulationReturnValue(item, fallbackName);
      if (parsed) return parsed;
    }
    return null;
  }

  if (value instanceof Map) {
    for (const entry of value.values()) {
      const parsed = parseSimulationReturnValue(entry, fallbackName);
      if (parsed) return parsed;
    }
    return null;
  }

  return normalizeNameRecordResult(value, fallbackName);
}

/**
 * Check if a name is available
 */
export async function checkAvailability(name: string): Promise<boolean> {
  try {
    const { rpc } = await import('@stellar/stellar-sdk');
    const server = new rpc.Server(STELLAR_NETWORK.rpcUrl);
    const contract = new Contract(NAMES_CONTRACT_ID);

    const result = await server.simulateTransaction(
      new TransactionBuilder(
        new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH', '0'),
        {
          fee: '100',
          networkPassphrase: STELLAR_NETWORK.networkPassphrase,
        },
      )
        .addOperation(contract.call('get_owner', nativeToScVal(name)))
        .setTimeout(30)
        .build(),
    );

    if ('error' in result) return false;
    if (!result.result || !('retval' in result.result)) return true;

    const value = scValToNative(result.result.retval);
    if (value === null || value === undefined || value === false) return true;
    const owner = asString(value);
    return owner !== undefined && owner !== '' && owner !== 'void';
  } catch {
    return true;
  }
}

/**
 * Build a registration transaction
 */
export async function buildRegisterTransaction(
  fromAddress: string,
  params: RegistrationParams,
): Promise<string> {
  const horizonUrl = STELLAR_NETWORK.horizonUrl;
  const networkPassphrase = STELLAR_NETWORK.networkPassphrase;

  const accountRes = await fetch(`${horizonUrl}/accounts/${fromAddress}`);
  if (!accountRes.ok) throw new Error('Failed to load account');
  const accountData = await accountRes.json();
  const sourceAccount = new Account(fromAddress, accountData.sequence);

  const contract = new Contract(NAMES_CONTRACT_ID);

  const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase })
    .addOperation(
      contract.call(
        'register',
        nativeToScVal(params.name),
        nativeToScVal(params.duration, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

/**
 * Build a transfer transaction
 */
export async function buildTransferTransaction(
  fromAddress: string,
  params: TransferParams,
): Promise<string> {
  const horizonUrl = STELLAR_NETWORK.horizonUrl;
  const networkPassphrase = STELLAR_NETWORK.networkPassphrase;

  const accountRes = await fetch(`${horizonUrl}/accounts/${fromAddress}`);
  if (!accountRes.ok) throw new Error('Failed to load account');
  const accountData = await accountRes.json();
  const sourceAccount = new Account(fromAddress, accountData.sequence);

  const contract = new Contract(NAMES_CONTRACT_ID);

  const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase })
    .addOperation(
      contract.call('transfer', nativeToScVal(params.name), new Address(params.to).toScVal()),
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

/**
 * Build a renewal transaction
 */
export async function buildRenewTransaction(
  fromAddress: string,
  params: RenewParams,
): Promise<string> {
  const horizonUrl = STELLAR_NETWORK.horizonUrl;
  const networkPassphrase = STELLAR_NETWORK.networkPassphrase;

  const accountRes = await fetch(`${horizonUrl}/accounts/${fromAddress}`);
  if (!accountRes.ok) throw new Error('Failed to load account');
  const accountData = await accountRes.json();
  const sourceAccount = new Account(fromAddress, accountData.sequence);

  const contract = new Contract(NAMES_CONTRACT_ID);

  const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase })
    .addOperation(
      contract.call(
        'renew',
        nativeToScVal(params.name),
        nativeToScVal(params.duration, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

/**
 * Build a metadata update transaction
 */
export async function buildSetMetadataTransaction(
  fromAddress: string,
  params: MetadataParams,
): Promise<string> {
  const horizonUrl = STELLAR_NETWORK.horizonUrl;
  const networkPassphrase = STELLAR_NETWORK.networkPassphrase;

  const accountRes = await fetch(`${horizonUrl}/accounts/${fromAddress}`);
  if (!accountRes.ok) throw new Error('Failed to load account');
  const accountData = await accountRes.json();
  const sourceAccount = new Account(fromAddress, accountData.sequence);

  const contract = new Contract(NAMES_CONTRACT_ID);

  // Build metadata map
  const metadataMap: xdr.ScMapEntry[] = [
    new xdr.ScMapEntry({
      key: nativeToScVal('avatar_url'),
      val: params.metadata.avatar_url
        ? nativeToScVal(params.metadata.avatar_url)
        : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('twitter_handle'),
      val: params.metadata.twitter_handle
        ? nativeToScVal(params.metadata.twitter_handle)
        : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('description'),
      val: params.metadata.description
        ? nativeToScVal(params.metadata.description)
        : xdr.ScVal.scvVoid(),
    }),
  ];

  const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase })
    .addOperation(
      contract.call('set_metadata', nativeToScVal(params.name), xdr.ScVal.scvMap(metadataMap)),
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

/**
 * Get name record from contract
 */
export async function getNameRecord(name: string): Promise<NameRecord | null> {
  try {
    const { rpc } = await import('@stellar/stellar-sdk');
    const server = new rpc.Server(STELLAR_NETWORK.rpcUrl);
    const contract = new Contract(NAMES_CONTRACT_ID);

    const result = await server.simulateTransaction(
      new TransactionBuilder(
        new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH', '0'),
        {
          fee: '100',
          networkPassphrase: STELLAR_NETWORK.networkPassphrase,
        },
      )
        .addOperation(contract.call('get_record', nativeToScVal(name)))
        .setTimeout(30)
        .build(),
    );

    if ('error' in result || !result.result || !('retval' in result.result)) {
      return null;
    }

    const nativeValue = scValToNative(result.result.retval);
    const parsed = parseSimulationReturnValue(nativeValue, name);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Get all names owned by an address
 */
export async function getOwnedNames(ownerAddress: string): Promise<string[]> {
  try {
    const { rpc } = await import('@stellar/stellar-sdk');
    const server = new rpc.Server(STELLAR_NETWORK.rpcUrl);
    const contract = new Contract(NAMES_CONTRACT_ID);

    const result = await server.simulateTransaction(
      new TransactionBuilder(
        new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH', '0'),
        {
          fee: '100',
          networkPassphrase: STELLAR_NETWORK.networkPassphrase,
        },
      )
        .addOperation(contract.call('get_names_by_owner', new Address(ownerAddress).toScVal()))
        .setTimeout(30)
        .build(),
    );

    if ('error' in result || !result.result || !('retval' in result.result)) {
      return [];
    }

    const value = scValToNative(result.result.retval);
    if (Array.isArray(value)) {
      return value
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry));
    }

    if (value instanceof Set) {
      return Array.from(value)
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry));
    }

    if (value instanceof Map) {
      return Array.from(value.keys())
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry));
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Submit a signed transaction to the network
 */
export async function submitTransaction(signedXdr: string): Promise<string> {
  const { rpc } = await import('@stellar/stellar-sdk');
  const server = new rpc.Server(STELLAR_NETWORK.rpcUrl);

  const tx = TransactionBuilder.fromXDR(signedXdr, STELLAR_NETWORK.networkPassphrase);
  const result = await server.sendTransaction(tx);

  if (result.status === 'ERROR') {
    throw new Error(result.errorResult?.toString() || 'Transaction failed');
  }

  return result.hash;
}
