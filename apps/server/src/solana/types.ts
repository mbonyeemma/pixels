/**
 * Types for the optional Solana Devnet payments. Nothing in here ever touches a private key: the server only knows
 * the treasury PUBLIC key, and players sign in their own wallets.
 */

export interface PaymentsConfig {
  enabled: boolean;
  /** only 'devnet' is accepted; anything else is a configuration error */
  cluster: 'devnet';
  rpcUrl: string;
  /** treasury PUBLIC key (base58); required when enabled */
  treasury: string | null;
  /** SPL token mint from SOLANA_TOKEN_MINT. Token pricing is NOT implemented: this is reported but ignored. */
  tokenMint: string | null;
  /** how long one /api/pay/confirm request keeps looking for a transaction that is not visible yet */
  confirmTimeoutMs: number;
}

export const DISABLED_PAYMENTS: PaymentsConfig = {
  enabled: false,
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  treasury: null,
  tokenMint: null,
  confirmTimeoutMs: 20_000,
};

/* ------------------------------------------------ the part of getTransaction (jsonParsed) we rely on */

export interface ParsedAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  source?: string;
}

export interface ParsedInstruction {
  program?: string;
  programId: string;
  /** for a parsed system transfer: { type: 'transfer', info: { source, destination, lamports } }; for a memo: a string */
  parsed?: unknown;
  accounts?: string[];
  data?: string;
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (ParsedAccountKey | string)[];
      instructions: ParsedInstruction[];
    };
  };
  version?: 'legacy' | number;
}

/**
 * The only thing the payments code needs from a Solana node. The real implementation talks JSON-RPC over fetch;
 * tests inject a mock.
 */
export interface SolanaRpc {
  /** genesis hash of the chain the node serves (identifies the cluster) */
  getGenesisHash(): Promise<string>;
  /** `getTransaction` with commitment 'confirmed', jsonParsed, maxSupportedTransactionVersion 0. null = not visible (yet). */
  getTransaction(signature: string): Promise<ParsedTransaction | null>;
}

/** The node could not be reached or answered with an error (transient: nothing about the payment is decided). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly transient = true,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
/** SPL Memo program v1 and v2 */
export const MEMO_PROGRAM_IDS: readonly string[] = ['Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'];
