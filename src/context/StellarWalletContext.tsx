import { createContext, useContext } from 'react';
import { STELLAR_NETWORK } from '@/config';
import { useStellarWallet as useStellarWalletHook } from '@/hooks/useStellarWallet';

interface StellarWalletContextValue {
  address: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signMessage: (message: string) => Promise<Uint8Array>;
  signTransaction: (xdr: string) => Promise<string>;
  openPicker: () => void;
  closePicker: () => void;
  walletId: string | null;
}

export const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: React.ReactNode }) {
  const stellarWallet = useStellarWalletHook();

  // Legacy signMessage - only supported by Freighter currently
  const signMessage = async (message: string): Promise<Uint8Array> => {
    // For now, signMessage is only implemented for Freighter
    // Other wallets don't support arbitrary message signing in the same way
    throw new Error('Message signing is currently only supported by Freighter wallet');
  };

  return (
    <StellarWalletContext.Provider
      value={{
        address: stellarWallet.publicKey,
        isConnected: stellarWallet.status === 'connected',
        connect: async () => {
          // If no wallet is selected, open picker
          if (!stellarWallet.walletId) {
            stellarWallet.openPicker();
            return;
          }
          // Otherwise reconnect with existing wallet
          if (stellarWallet.walletId) {
            await stellarWallet.connect(stellarWallet.walletId);
          }
        },
        disconnect: () => stellarWallet.disconnect(),
        signMessage,
        signTransaction: stellarWallet.signTransaction,
        openPicker: stellarWallet.openPicker,
        closePicker: stellarWallet.closePicker,
        walletId: stellarWallet.walletId,
      }}
    >
      {children}
    </StellarWalletContext.Provider>
  );
}

export function useStellarWallet() {
  const ctx = useContext(StellarWalletContext);
  if (!ctx) throw new Error('useStellarWallet must be used within StellarWalletProvider');
  return ctx;
}
