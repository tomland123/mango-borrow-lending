// @ts-nocheck

import {
  closeAccount,
  initializeAccount,
  SRM_DECIMALS,
  WRAPPED_SOL_MINT,
} from '@project-serum/serum/lib/token-instructions';
import { TokenInstructions, TOKEN_MINTS } from '@project-serum/serum';
import BN from 'bn.js';
import {
  Account,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  encodeMangoInstruction,
  NUM_MARKETS,
  NUM_TOKENS,
} from '@blockworks-foundation/mango-client/lib/layout';
import {
  makeBorrowInstruction,
  makeSettleBorrowInstruction,
  makeSettleFundsInstruction,
  makeWithdrawInstruction,
} from '@blockworks-foundation/mango-client/lib/instruction';
import { Market } from '@project-serum/serum';
import {
  MangoGroup,
  MangoSrmAccountLayout,
  MarginAccount,
  MarginAccountLayout,
  ACCOUNT_LAYOUT,
  uiToNative,
  sleep,
} from '@blockworks-foundation/mango-client';
import * as bs58 from 'bs58';

const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: PublicKey = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

export const formatTokenMints = (symbols: { [name: string]: string }) => {
  return Object.entries(symbols).map(([name, address]) => {
    return {
      address: new PublicKey(address),
      name: name,
    };
  });
};

export function getOwnedAccountsFilters(publicKey: PublicKey) {
  return [
    {
      memcmp: {
        offset: ACCOUNT_LAYOUT.offsetOf('owner'),
        bytes: publicKey.toBase58(),
      },
    },
    {
      dataSize: ACCOUNT_LAYOUT.span,
    },
  ];
}

export function parseTokenAccountData(data: Buffer): {
  mint: PublicKey;
  owner: PublicKey;
  amount: number;
} {
  const { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount,
  };
}

export async function getOwnedSplTokenAccounts(
  connection: Connection,
  publicKey: PublicKey,
): Promise<any[]> {
  const filters = getOwnedAccountsFilters(publicKey);
  // @ts-ignore
  const resp = await connection._rpcRequest('getProgramAccounts', [
    TokenInstructions.TOKEN_PROGRAM_ID.toBase58(),
    {
      commitment: connection.commitment,
      filters,
    },
  ]);
  if (resp.error) {
    throw new Error(
      'failed to get token accounts owned by ' +
        publicKey.toBase58() +
        ': ' +
        resp.error.message,
    );
  }
  return resp.result.map(({ pubkey, account: { data } }) => {
    data = bs58.decode(data);
    const accountData = parseTokenAccountData(data);
    return {
      type: getSymbolForTokenMintAddress(accountData.mint.toString()),
      publicKey: new PublicKey(pubkey),
      account: accountData,
    };
  });
}

export async function getWalletTokenInfo(
  connection: Connection,
  ownerPublicKey: PublicKey,
) {
  const splAccounts = await getOwnedSplTokenAccounts(
    connection,
    ownerPublicKey,
  );
  const account = await connection.getAccountInfo(ownerPublicKey);
  if (!account) return splAccounts;
  return [
    {
      publicKey: ownerPublicKey,
      account: {
        mint: WRAPPED_SOL_MINT,
        owner: ownerPublicKey,
        amount: account.lamports,
      },
    },
  ].concat(splAccounts);
}

export const getSymbolForTokenMintAddress = (address: string): string => {
  if (address && address.length) {
    return (
      TOKEN_MINTS.find((m) => m.address.toString() === address)?.name || ''
    );
  } else {
    return '';
  }
};
export async function createAccountInstruction(
  connection: Connection,
  payer: PublicKey,
  space: number,
  owner: PublicKey,
  lamports?: number,
): Promise<{ account: Account; instruction: TransactionInstruction }> {
  console.log(payer, owner);
  const account = new Account();
  const instruction = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: account.publicKey,
    lamports: lamports
      ? lamports
      : await connection.getMinimumBalanceForRentExemption(space),
    space,
    programId: owner,
  });

  return { account, instruction };
}

export async function initMarginAccountAndDeposit(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  wallet: any,
  token: PublicKey,
  tokenAcc: PublicKey,
  quantity: number,
): Promise<Array<any>> {
  const transaction = new Transaction();
  const signers = [];

  let wrappedSolAccount: Account | null = null;
  if (token.equals(WRAPPED_SOL_MINT)) {
    wrappedSolAccount = new Account();
    const lamports = Math.round(quantity * LAMPORTS_PER_SOL) + 1e7;
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: wrappedSolAccount.publicKey,
        lamports: quantity,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
    );
    transaction.add(
      initializeAccount({
        account: wrappedSolAccount.publicKey,
        mint: WRAPPED_SOL_MINT,
        owner: wallet.publicKey,
      }),
    );
    signers.push(wrappedSolAccount);
  }
  // Create a Solana account for the MarginAccount and allocate spac

  const accInstr = await createAccountInstruction(
    connection,
    wallet.publicKey,
    MarginAccountLayout.span,
    new PublicKey(programId),
  );

  console.log(accInstr, 'account instr!!');

  // Specify the accounts this instruction takes in (see program/src/instruction.rs)
  const keys = [
    { isSigner: false, isWritable: false, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: accInstr.account.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY },
  ];

  // Encode and create instruction for actual initMarginAccount instruction
  const data = encodeMangoInstruction({ InitMarginAccount: {} });
  const initMarginAccountInstruction = new TransactionInstruction({
    keys,
    data,
    programId,
  });

  // Add all instructions to one atomic transaction
  transaction.add(accInstr.instruction);
  transaction.add(initMarginAccountInstruction);

  const tokenIndex = mangoGroup.getTokenIndex(token);
  const nativeQuantity = uiToNative(
    quantity,
    mangoGroup.mintDecimals[tokenIndex],
  );

  const depositKeys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: accInstr.account.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: wrappedSolAccount?.publicKey ?? tokenAcc,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[tokenIndex],
    },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
  ];
  const depositData = encodeMangoInstruction({
    Deposit: { quantity: nativeQuantity },
  });

  const instruction = new TransactionInstruction({
    keys: depositKeys,
    data: depositData,
    programId,
  });
  transaction.add(instruction);

  if (wrappedSolAccount) {
    transaction.add(
      closeAccount({
        source: wrappedSolAccount.publicKey,
        destination: wallet.publicKey,
        owner: wallet.publicKey,
      }),
    );
  }

  // Specify signers in addition to the wallet
  signers.push(accInstr.account);
  const functionName = 'InitMarginAccount';
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${functionName} instruction success`;

  const trxHash = await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
    sendingMessage,
    successMessage,
  });
  return [accInstr.account, trxHash];
}

export async function findAssociatedTokenAddress(
  walletAddress: PublicKey,
  tokenMintAddress: PublicKey,
): Promise<PublicKey> {
  return (
    await PublicKey.findProgramAddress(
      [
        walletAddress.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        tokenMintAddress.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    )
  )[0];
}

export async function createAssociatedTokenAccount(
  fundingAddress: PublicKey,
  walletAddress: PublicKey,
  splTokenMintAddress: PublicKey,
): Promise<TransactionInstruction> {
  const associatedTokenAddress = await findAssociatedTokenAddress(
    walletAddress,
    splTokenMintAddress,
  );
  const keys = [
    {
      pubkey: fundingAddress,
      isSigner: true,
      isWritable: true,
    },
    {
      pubkey: associatedTokenAddress,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: walletAddress,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: splTokenMintAddress,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: SYSVAR_RENT_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
  ];
  return new TransactionInstruction({
    keys,
    programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

export async function withdraw(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  token: PublicKey,
  quantity: number,
): Promise<TransactionSignature> {
  const transaction = new Transaction();
  const signers = [];
  let tokenAcc = await findAssociatedTokenAddress(wallet.publicKey, token);

  let wrappedSolAccount: Account | null = null;
  if (token.equals(WRAPPED_SOL_MINT)) {
    wrappedSolAccount = new Account();
    tokenAcc = wrappedSolAccount.publicKey;
    const space = 165;
    const lamports = await connection.getMinimumBalanceForRentExemption(
      space,
      'singleGossip',
    );
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: tokenAcc,
        lamports,
        space,
        programId: TOKEN_PROGRAM_ID,
      }),
    );
    transaction.add(
      initializeAccount({
        account: tokenAcc,
        mint: WRAPPED_SOL_MINT,
        owner: wallet.publicKey,
      }),
    );
    signers.push(wrappedSolAccount);
  } else {
    const tokenAccExists = await connection.getAccountInfo(tokenAcc, 'recent');
    if (!tokenAccExists) {
      transaction.add(
        await createAssociatedTokenAccount(
          wallet.publicKey,
          wallet.publicKey,
          token,
        ),
      );
    }
  }

  const tokenIndex = mangoGroup.getTokenIndex(token);
  const nativeQuantity = uiToNative(
    quantity,
    mangoGroup.mintDecimals[tokenIndex],
  );

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: tokenAcc,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[tokenIndex],
    },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ...marginAccount.openOrders.map((pubkey) => ({
      isSigner: false,
      isWritable: false,
      pubkey,
    })),
    ...mangoGroup.oracles.map((pubkey) => ({
      isSigner: false,
      isWritable: false,
      pubkey,
    })),
  ];
  const data = encodeMangoInstruction({
    Withdraw: { quantity: nativeQuantity },
  });
  const instruction = new TransactionInstruction({ keys, data, programId });
  transaction.add(instruction);

  if (wrappedSolAccount) {
    transaction.add(
      closeAccount({
        source: wrappedSolAccount.publicKey,
        destination: wallet.publicKey,
        owner: wallet.publicKey,
      }),
    );
  }

  const functionName = 'Withdraw';
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${functionName} instruction success`;
  return await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
    sendingMessage,
    successMessage,
  });
}

export async function borrowAndWithdraw(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  token: PublicKey,
  withdrawQuantity: number,
): Promise<TransactionSignature> {
  const transaction = new Transaction();
  const signers = [];
  let tokenAcc = await findAssociatedTokenAddress(wallet.publicKey, token);

  let wrappedSolAccount: Account | null = null;
  if (token.equals(WRAPPED_SOL_MINT)) {
    wrappedSolAccount = new Account();
    tokenAcc = wrappedSolAccount.publicKey;
    const space = 165;
    const lamports = await connection.getMinimumBalanceForRentExemption(
      space,
      'singleGossip',
    );
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: tokenAcc,
        lamports,
        space,
        programId: TOKEN_PROGRAM_ID,
      }),
    );
    transaction.add(
      initializeAccount({
        account: wrappedSolAccount.publicKey,
        mint: WRAPPED_SOL_MINT,
        owner: wallet.publicKey,
      }),
    );
    signers.push(wrappedSolAccount);
  } else {
    const tokenAccExists = await connection.getAccountInfo(tokenAcc, 'recent');
    if (!tokenAccExists) {
      transaction.add(
        await createAssociatedTokenAccount(
          wallet.publicKey,
          wallet.publicKey,
          token,
        ),
      );
    }
  }

  const tokenIndex = mangoGroup.getTokenIndex(token);
  const tokenBalance = marginAccount.getUiDeposit(mangoGroup, tokenIndex);
  const borrowQuantity = withdrawQuantity - tokenBalance;

  const nativeBorrowQuantity = new BN(
    Math.ceil(
      borrowQuantity * Math.pow(10, mangoGroup.mintDecimals[tokenIndex]),
    ),
  ).add(new BN(1));
  // add a lamport to make sure that we don't run into rounding issues
  // between borrow & withdraw

  const borrowInstruction = makeBorrowInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    tokenIndex,
    marginAccount.openOrders,
    mangoGroup.oracles,
    nativeBorrowQuantity,
  );
  transaction.add(borrowInstruction);

  // uiToNative() uses Math.round causing
  // errors so we use Math.floor here instead
  const nativeWithdrawQuantity = new BN(
    Math.floor(
      withdrawQuantity * Math.pow(10, mangoGroup.mintDecimals[tokenIndex]),
    ),
  );

  const withdrawInstruction = makeWithdrawInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    mangoGroup.signerKey,
    tokenAcc,
    mangoGroup.vaults[tokenIndex],
    marginAccount.openOrders,
    mangoGroup.oracles,
    nativeWithdrawQuantity,
  );
  transaction.add(withdrawInstruction);

  const settleBorrowInstruction = makeSettleBorrowInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    tokenIndex,
    nativeWithdrawQuantity,
  );
  transaction.add(settleBorrowInstruction);

  if (wrappedSolAccount) {
    transaction.add(
      closeAccount({
        source: wrappedSolAccount.publicKey,
        destination: wallet.publicKey,
        owner: wallet.publicKey,
      }),
    );
  }

  return await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
  });
}

export async function borrow(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  token: PublicKey,

  quantity: number,
): Promise<TransactionSignature> {
  const tokenIndex = mangoGroup.getTokenIndex(token);
  const nativeQuantity = uiToNative(
    quantity,
    mangoGroup.mintDecimals[tokenIndex],
  );

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ...marginAccount.openOrders.map((pubkey) => ({
      isSigner: false,
      isWritable: false,
      pubkey,
    })),
    ...mangoGroup.oracles.map((pubkey) => ({
      isSigner: false,
      isWritable: false,
      pubkey,
    })),
  ];
  const data = encodeMangoInstruction({
    Borrow: { tokenIndex: new BN(tokenIndex), quantity: nativeQuantity },
  });

  const instruction = new TransactionInstruction({ keys, data, programId });

  const transaction = new Transaction();
  transaction.add(instruction);
  const signers = [];
  const functionName = 'Borrow';
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${functionName} instruction success`;
  return await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
    sendingMessage,
    successMessage,
  });
}

export async function settleBorrow(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,

  token: PublicKey,
  quantity: number,
): Promise<TransactionSignature> {
  const tokenIndex = mangoGroup.getTokenIndex(token);
  const nativeQuantity = uiToNative(
    quantity,
    mangoGroup.mintDecimals[tokenIndex],
  );
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
  ];
  const data = encodeMangoInstruction({
    SettleBorrow: { tokenIndex: new BN(tokenIndex), quantity: nativeQuantity },
  });
  const instruction = new TransactionInstruction({ keys, data, programId });

  const transaction = new Transaction();
  transaction.add(instruction);
  return await packageAndSend(
    transaction,
    connection,
    wallet,
    [],
    'SettleBorrow',
  );
}

// Settle all borrows in one transaction
export async function settleAllBorrows(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,

  token: Array<PublicKey>,
  quantity: Array<number>,
): Promise<TransactionSignature> {
  // Pack all transaction into one transaction
  const transaction = new Transaction();
  // Signer of the transaction
  const signers = [];
  // Add each token into transaction
  token.forEach((tok: PublicKey, i: number) => {
    const tokenIndex = mangoGroup.getTokenIndex(tok);
    const nativeQuantity = uiToNative(
      quantity[i],
      mangoGroup.mintDecimals[tokenIndex],
    );
    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ];
    const data = encodeMangoInstruction({
      SettleBorrow: {
        tokenIndex: new BN(tokenIndex),
        quantity: nativeQuantity,
      },
    });
    const instruction = new TransactionInstruction({ keys, data, programId });

    transaction.add(instruction);
  });
  const functionName = 'SettleBorrows';
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${functionName} instruction success`;

  return await sendTransaction({
    transaction,
    connection,
    wallet,
    signers,
    sendingMessage,
    successMessage,
  });
}

/**
 * If there is no mangoSrmAccount provided, it will create one in the same transaction
 */
export async function depositSrm(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  wallet: any,
  srmAccount: PublicKey,
  quantity: number,

  mangoSrmAccount?: PublicKey,
): Promise<PublicKey> {
  const transaction = new Transaction();
  const additionalSigners: Account[] = [];
  if (!mangoSrmAccount) {
    const accInstr = await createAccountInstruction(
      connection,
      wallet.publicKey,
      MangoSrmAccountLayout.span,
      programId,
    );

    transaction.add(accInstr.instruction);
    additionalSigners.push(accInstr.account);
    mangoSrmAccount = accInstr.account.publicKey;
  }

  const nativeQuantity = uiToNative(quantity, SRM_DECIMALS);

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: mangoSrmAccount },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: true, pubkey: srmAccount },
    { isSigner: false, isWritable: true, pubkey: mangoGroup.srmVault },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY },
  ];
  const data = encodeMangoInstruction({
    DepositSrm: { quantity: nativeQuantity },
  });
  const instruction = new TransactionInstruction({ keys, data, programId });
  transaction.add(instruction);

  await packageAndSend(
    transaction,
    connection,
    wallet,
    additionalSigners,
    'Deposit SRM',
  );
  return mangoSrmAccount;
}

export async function withdrawSrm(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  mangoSrmAccount: any,
  wallet: any,
  srmAccount: PublicKey,

  quantity: number,
): Promise<TransactionSignature> {
  const nativeQuantity = uiToNative(quantity, SRM_DECIMALS);

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: false, isWritable: true, pubkey: mangoSrmAccount.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: true, pubkey: srmAccount },
    { isSigner: false, isWritable: true, pubkey: mangoGroup.srmVault },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
  ];
  const data = encodeMangoInstruction({
    WithdrawSrm: { quantity: nativeQuantity },
  });
  const instruction = new TransactionInstruction({ keys, data, programId });

  const transaction = new Transaction();
  transaction.add(instruction);
  return await packageAndSend(
    transaction,
    connection,
    wallet,
    [],
    'WithdrawSrm',
  );
}

export async function placeAndSettle(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  spotMarket: Market,
  wallet: any,

  side: 'buy' | 'sell',
  price: number,
  size: number,
  orderType?: 'limit' | 'ioc' | 'postOnly',
  clientId?: BN,
): Promise<TransactionSignature> {
  orderType = orderType == undefined ? 'limit' : orderType;
  // orderType = orderType ?? 'limit'
  const limitPrice = spotMarket.priceNumberToLots(price);
  const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

  // const feeTier = getFeeTier(
  //   0,
  //   nativeToUi(mangoGroup.nativeSrm || 0, SRM_DECIMALS),
  // );
  const rates = getFeeRates(feeTier);
  const maxQuoteQuantity = new BN(
    maxBaseQuantity
      .mul(limitPrice)
      .mul(spotMarket['_decoded'].quoteLotSize)
      .toNumber() *
      (1 + rates.taker),
  );

  console.log(maxBaseQuantity.toString(), maxQuoteQuantity.toString());

  if (maxBaseQuantity.lte(new BN(0))) {
    throw new Error('size too small');
  }
  if (limitPrice.lte(new BN(0))) {
    throw new Error('invalid price');
  }
  const selfTradeBehavior = 'decrementTake';
  const marketIndex = mangoGroup.getMarketIndex(spotMarket);
  // const vaultIndex = side === 'buy' ? mangoGroup.vaults.length - 1 : marketIndex

  // Add all instructions to one atomic transaction
  const transaction = new Transaction();

  // Specify signers in addition to the wallet
  const signers: Account[] = [];

  const dexSigner = await PublicKey.createProgramAddress(
    [
      spotMarket.publicKey.toBuffer(),
      spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
    ],
    spotMarket.programId,
  );

  // Create a Solana account for the open orders account if it's missing
  const openOrdersKeys: PublicKey[] = [];
  for (let i = 0; i < marginAccount.openOrders.length; i++) {
    if (
      i === marketIndex &&
      marginAccount.openOrders[marketIndex].equals(zeroKey)
    ) {
      // open orders missing for this market; create a new one now
      const openOrdersSpace = OpenOrders.getLayout(
        mangoGroup.dexProgramId,
      ).span;
      const openOrdersLamports =
        await connection.getMinimumBalanceForRentExemption(
          openOrdersSpace,
          'singleGossip',
        );
      const accInstr = await createAccountInstruction(
        connection,
        wallet.publicKey,
        openOrdersSpace,
        mangoGroup.dexProgramId,
        openOrdersLamports,
      );

      transaction.add(accInstr.instruction);
      signers.push(accInstr.account);
      openOrdersKeys.push(accInstr.account.publicKey);
    } else {
      openOrdersKeys.push(marginAccount.openOrders[i]);
    }
  }

  // Only send a pre-settle instruction if open orders account already exists
  if (!marginAccount.openOrders[marketIndex].equals(zeroKey)) {
    const settleFundsInstr = makeSettleFundsInstruction(
      programId,
      mangoGroup.publicKey,
      wallet.publicKey,
      marginAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      openOrdersKeys[marketIndex],
      mangoGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      mangoGroup.vaults[marketIndex],
      mangoGroup.vaults[NUM_TOKENS - 1],
      dexSigner,
    );
    transaction.add(settleFundsInstr);
  }

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
    { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].requestQueue,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].eventQueue,
    },
    { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].bids },
    { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].asks },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[marketIndex],
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[NUM_TOKENS - 1],
    },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].baseVault,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].quoteVault,
    },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_RENT_PUBKEY },
    { isSigner: false, isWritable: true, pubkey: mangoGroup.srmVault },
    { isSigner: false, isWritable: false, pubkey: dexSigner },
    ...openOrdersKeys.map((pubkey) => ({
      isSigner: false,
      isWritable: true,
      pubkey,
    })),
    ...mangoGroup.oracles.map((pubkey) => ({
      isSigner: false,
      isWritable: false,
      pubkey,
    })),
  ];

  const data = encodeMangoInstruction({
    PlaceAndSettle: clientId
      ? {
          side,
          limitPrice,
          maxBaseQuantity,
          maxQuoteQuantity,
          selfTradeBehavior,
          orderType,
          clientId,
          limit: 65535,
        }
      : {
          side,
          limitPrice,
          maxBaseQuantity,
          maxQuoteQuantity,
          selfTradeBehavior,
          orderType,
          limit: 65535,
        },
  });

  const placeAndSettleInstruction = new TransactionInstruction({
    keys,
    data,
    programId,
  });
  transaction.add(placeAndSettleInstruction);

  return await packageAndSend(
    transaction,
    connection,
    wallet,
    signers,
    'place order and settle',
  );
}

export async function settleFundsAndBorrows(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  spotMarket: Market,
): Promise<TransactionSignature> {
  const transaction = new Transaction();
  const marketIndex = mangoGroup.getMarketIndex(spotMarket);
  const dexSigner = await PublicKey.createProgramAddress(
    [
      spotMarket.publicKey.toBuffer(),
      spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
    ],
    spotMarket.programId,
  );
  const settleFundsIns = await makeSettleFundsInstruction(
    programId,
    mangoGroup.publicKey,
    wallet.publicKey,
    marginAccount.publicKey,
    spotMarket.programId,
    spotMarket.publicKey,
    marginAccount.openOrders[marketIndex],
    mangoGroup.signerKey,
    spotMarket['_decoded'].baseVault,
    spotMarket['_decoded'].quoteVault,
    mangoGroup.vaults[marketIndex],
    mangoGroup.vaults[mangoGroup.vaults.length - 1],
    dexSigner,
  );
  transaction.add(settleFundsIns);

  const tokenIndex = marketIndex;
  const quantity = marginAccount.getUiBorrow(mangoGroup, tokenIndex);
  const nativeQuantity = uiToNative(
    quantity,
    mangoGroup.mintDecimals[tokenIndex],
  );

  const settleBorrowIns = await makeSettleBorrowInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    tokenIndex,
    nativeQuantity,
  );

  transaction.add(settleBorrowIns);
  const signers = [];
  return await packageAndSend(
    transaction,
    connection,
    wallet,
    signers,
    'Settle Funds',
  );
}

export async function settleFunds(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  spotMarket: Market,
): Promise<TransactionSignature> {
  const marketIndex = mangoGroup.getMarketIndex(spotMarket);
  const dexSigner = await PublicKey.createProgramAddress(
    [
      spotMarket.publicKey.toBuffer(),
      spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
    ],
    spotMarket.programId,
  );

  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
    { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: marginAccount.openOrders[marketIndex],
    },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].baseVault,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].quoteVault,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[marketIndex],
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: mangoGroup.vaults[mangoGroup.vaults.length - 1],
    },
    { isSigner: false, isWritable: false, pubkey: dexSigner },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
  ];
  const data = encodeMangoInstruction({ SettleFunds: {} });

  const instruction = new TransactionInstruction({ keys, data, programId });

  // Add all instructions to one atomic transaction
  const transaction = new Transaction();
  transaction.add(instruction);

  const signers = [];
  const functionName = 'SettleFunds';
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${functionName} instruction success`;
  return await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
    sendingMessage,
    successMessage,
  });
}

export async function cancelOrderAndSettle(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  wallet: any,
  spotMarket: Market,
  order: any,
): Promise<TransactionSignature> {
  const keys = [
    { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
    { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
    { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
    { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.dexProgramId },
    { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
    { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].bids },
    { isSigner: false, isWritable: true, pubkey: spotMarket['_decoded'].asks },
    { isSigner: false, isWritable: true, pubkey: order.openOrdersAddress },
    { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
    {
      isSigner: false,
      isWritable: true,
      pubkey: spotMarket['_decoded'].eventQueue,
    },
  ];

  const data = encodeMangoInstruction({
    CancelOrder: {
      side: order.side,
      orderId: order.orderId,
    },
  });

  const instruction = new TransactionInstruction({ keys, data, programId });

  const transaction = new Transaction();
  transaction.add(instruction);

  const marketIndex = mangoGroup.getMarketIndex(spotMarket);
  const dexSigner = await PublicKey.createProgramAddress(
    [
      spotMarket.publicKey.toBuffer(),
      spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
    ],
    spotMarket.programId,
  );
  const settleFundsIns = await makeSettleFundsInstruction(
    programId,
    mangoGroup.publicKey,
    wallet.publicKey,
    marginAccount.publicKey,
    spotMarket.programId,
    spotMarket.publicKey,
    marginAccount.openOrders[marketIndex],
    mangoGroup.signerKey,
    spotMarket['_decoded'].baseVault,
    spotMarket['_decoded'].quoteVault,
    mangoGroup.vaults[marketIndex],
    mangoGroup.vaults[mangoGroup.vaults.length - 1],
    dexSigner,
  );
  transaction.add(settleFundsIns);

  const baseTokenIndex = marketIndex;
  const quoteTokenIndex = NUM_TOKENS - 1;

  const baseTokenQuantity = marginAccount.getUiBorrow(
    mangoGroup,
    baseTokenIndex,
  );
  const baseTokenNativeQuantity = uiToNative(
    baseTokenQuantity,
    mangoGroup.mintDecimals[baseTokenIndex],
  );

  const quoteTokenQuantity = marginAccount.getUiBorrow(
    mangoGroup,
    quoteTokenIndex,
  );
  const quoteTokenNativeQuantity = uiToNative(
    quoteTokenQuantity,
    mangoGroup.mintDecimals[quoteTokenIndex],
  );

  const settleBorrowBaseToken = await makeSettleBorrowInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    baseTokenIndex,
    baseTokenNativeQuantity,
  );

  transaction.add(settleBorrowBaseToken);

  const settleBorrowQuoteToken = await makeSettleBorrowInstruction(
    programId,
    mangoGroup.publicKey,
    marginAccount.publicKey,
    wallet.publicKey,
    quoteTokenIndex,
    quoteTokenNativeQuantity,
  );

  transaction.add(settleBorrowQuoteToken);

  return await packageAndSend(
    transaction,
    connection,
    wallet,
    [],
    'CancelOrder',
  );
}

export async function settleAll(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  markets: Market[],
  wallet: any,
): Promise<TransactionSignature> {
  const transaction = new Transaction();

  const assetGains: number[] = new Array(NUM_TOKENS).fill(0);

  for (let i = 0; i < NUM_MARKETS; i++) {
    const openOrdersAccount = marginAccount.openOrdersAccounts[i];
    if (openOrdersAccount === undefined) {
      continue;
    } else if (
      openOrdersAccount.quoteTokenFree.toNumber() +
        openOrdersAccount['referrerRebatesAccrued'].toNumber() ===
        0 &&
      openOrdersAccount.baseTokenFree.toNumber() === 0
    ) {
      continue;
    }

    assetGains[i] += openOrdersAccount.baseTokenFree.toNumber();
    assetGains[NUM_TOKENS - 1] +=
      openOrdersAccount.quoteTokenFree.toNumber() +
      openOrdersAccount['referrerRebatesAccrued'].toNumber();

    const spotMarket = markets[i];
    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
      { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
      {
        isSigner: false,
        isWritable: true,
        pubkey: marginAccount.openOrders[i],
      },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
      {
        isSigner: false,
        isWritable: true,
        pubkey: spotMarket['_decoded'].baseVault,
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: spotMarket['_decoded'].quoteVault,
      },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[i] },
      {
        isSigner: false,
        isWritable: true,
        pubkey: mangoGroup.vaults[mangoGroup.vaults.length - 1],
      },
      { isSigner: false, isWritable: false, pubkey: dexSigner },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    ];
    const data = encodeMangoInstruction({ SettleFunds: {} });

    const settleFundsInstruction = new TransactionInstruction({
      keys,
      data,
      programId,
    });

    transaction.add(settleFundsInstruction);
  }

  const deposits = marginAccount.getDeposits(mangoGroup);
  const liabs = marginAccount.getLiabs(mangoGroup);

  for (let i = 0; i < NUM_TOKENS; i++) {
    // TODO test this. maybe it hits transaction size limit

    const deposit = deposits[i] + assetGains[i];
    if (deposit === 0 || liabs[i] === 0) {
      continue;
    }
    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ];
    const data = encodeMangoInstruction({
      SettleBorrow: {
        tokenIndex: new BN(i),
        quantity: uiToNative(liabs[i] * 2, mangoGroup.mintDecimals[i]),
      },
    });

    const settleBorrowsInstruction = new TransactionInstruction({
      keys,
      data,
      programId,
    });
    transaction.add(settleBorrowsInstruction);
  }

  if (transaction.instructions.length === 0) {
    throw new Error('No unsettled funds');
  }

  return await packageAndSend(
    transaction,
    connection,
    wallet,
    [],
    'Settle All',
  );
}

async function packageAndSend(
  transaction: Transaction,
  connection: Connection,
  wallet: any,
  signers: Account[],
  functionName: string,
): Promise<TransactionSignature> {
  const sendingMessage = `Sending ${functionName} instruction...`;
  const successMessage = `${capitalize(functionName)} instruction success`;
  return await sendTransaction({
    transaction,
    wallet,
    signers,
    connection,
    sendingMessage,
    successMessage,
  });
}

export async function settleAllTrades(
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  marginAccount: MarginAccount,
  markets: Market[],
  wallet: any,
): Promise<TransactionSignature> {
  const transaction = new Transaction();

  const assetGains: number[] = new Array(NUM_TOKENS).fill(0);

  for (let i = 0; i < NUM_MARKETS; i++) {
    const openOrdersAccount = marginAccount.openOrdersAccounts[i];
    if (openOrdersAccount === undefined) {
      continue;
    } else if (
      openOrdersAccount.quoteTokenFree.toNumber() === 0 &&
      openOrdersAccount.baseTokenFree.toNumber() === 0
    ) {
      continue;
    }

    assetGains[i] += openOrdersAccount.baseTokenFree.toNumber();
    assetGains[NUM_TOKENS - 1] += openOrdersAccount.quoteTokenFree.toNumber();

    const spotMarket = markets[i];
    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: true, isWritable: false, pubkey: wallet.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount.publicKey },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
      { isSigner: false, isWritable: false, pubkey: spotMarket.programId },
      { isSigner: false, isWritable: true, pubkey: spotMarket.publicKey },
      {
        isSigner: false,
        isWritable: true,
        pubkey: marginAccount.openOrders[i],
      },
      { isSigner: false, isWritable: false, pubkey: mangoGroup.signerKey },
      {
        isSigner: false,
        isWritable: true,
        pubkey: spotMarket['_decoded'].baseVault,
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: spotMarket['_decoded'].quoteVault,
      },
      { isSigner: false, isWritable: true, pubkey: mangoGroup.vaults[i] },
      {
        isSigner: false,
        isWritable: true,
        pubkey: mangoGroup.vaults[mangoGroup.vaults.length - 1],
      },
      { isSigner: false, isWritable: false, pubkey: dexSigner },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    ];
    const data = encodeMangoInstruction({ SettleFunds: {} });

    const settleFundsInstruction = new TransactionInstruction({
      keys,
      data,
      programId,
    });
    transaction.add(settleFundsInstruction);
  }

  if (transaction.instructions.length === 0) {
    throw new Error('No unsettled funds');
  }

  return await packageAndSend(
    transaction,
    connection,
    wallet,
    [],
    'Settle All Trades',
  );
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

const DEFAULT_TIMEOUT = 30000;

export async function sendTransaction({
  transaction,
  wallet,
  signers = [],
  connection,
  sendingMessage = 'Sending transaction...',
  successMessage = 'Transaction confirmed',
  timeout = DEFAULT_TIMEOUT,
}: {
  transaction: Transaction;
  wallet: any;
  signers?: Array<Account>;
  connection: Connection;
  sendingMessage?: string;
  successMessage?: string;
  timeout?: number;
}) {
  const signedTransaction = await signTransaction({
    transaction,
    wallet,
    signers,
    connection,
  });
  return await sendSignedTransaction({
    signedTransaction,
    connection,
    sendingMessage,
    successMessage,
    timeout,
  });
}

export async function signTransaction({
  transaction,
  wallet,
  signers = [],
  connection,
}: {
  transaction: Transaction;
  wallet: any;
  signers?: Array<Account>;
  connection: Connection;
}) {
  transaction.recentBlockhash = (
    await connection.getRecentBlockhash('max')
  ).blockhash;
  transaction.setSigners(wallet.publicKey, ...signers.map((s) => s.publicKey));
  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  return await wallet.signTransaction(transaction);
}

export async function signTransactions({
  transactionsAndSigners,
  wallet,
  connection,
}: {
  transactionsAndSigners: {
    transaction: Transaction;
    signers?: Array<Account>;
  }[];
  wallet: any;
  connection: Connection;
}) {
  const blockhash = (await connection.getRecentBlockhash('max')).blockhash;
  transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
    transaction.recentBlockhash = blockhash;
    transaction.setSigners(
      wallet.publicKey,
      ...signers.map((s) => s.publicKey),
    );
    if (signers?.length > 0) {
      transaction.partialSign(...signers);
    }
  });
  return await wallet.signAllTransactions(
    transactionsAndSigners.map(({ transaction }) => transaction),
  );
}

export async function sendSignedTransaction({
  signedTransaction,
  connection,
  sendingMessage = 'Sending transaction...',
  successMessage = 'Transaction confirmed',
  timeout = DEFAULT_TIMEOUT,
}: {
  signedTransaction: Transaction;
  connection: Connection;
  sendingMessage?: string;
  successMessage?: string;
  timeout?: number;
}): Promise<string> {
  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  const txid: TransactionSignature = await connection.sendRawTransaction(
    rawTransaction,
    {
      skipPreflight: true,
    },
  );

  console.log('Started awaiting confirmation for', txid);

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < timeout) {
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
      await sleep(300);
    }
  })();
  try {
    await awaitTransactionSignatureConfirmation(txid, timeout, connection);
  } catch (err) {
    if (err.timeout) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (
        await simulateTransaction(connection, signedTransaction, 'single')
      ).value;
    } catch (e) {
      console.log('Error: ', e);
    }
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw new TransactionError(
              'Transaction failed: ' + line.slice('Program log: '.length),
              txid,
            );
          }
        }
      }
      throw new TransactionError(JSON.stringify(simulateResult.err), txid);
    }
    throw new TransactionError('Transaction failed', txid);
  } finally {
    done = true;
  }

  console.log('Latency', txid, getUnixTs() - startTime);
  return txid;
}

async function awaitTransactionSignatureConfirmation(
  txid: TransactionSignature,
  timeout: number,
  connection: Connection,
) {
  let done = false;
  const result = await new Promise((resolve, reject) => {
    // eslint-disable-next-line
    (async () => {
      setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        console.log('Timed out for txid', txid);
        reject({ timeout: true });
      }, timeout);
      try {
        connection.onSignature(
          txid,
          (result) => {
            console.log('WS confirmed', txid, result);
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          connection.commitment,
        );
        console.log('Set up WS connection', txid);
      } catch (e) {
        done = true;
        console.log('WS error in setup', txid, e);
      }
      while (!done) {
        // eslint-disable-next-line
        (async () => {
          try {
            const signatureStatuses = await connection.getSignatureStatuses([
              txid,
            ]);
            const result = signatureStatuses && signatureStatuses.value[0];
            if (!done) {
              if (!result) {
                // console.log('REST null result for', txid, result);
              } else if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              }
              // @ts-ignore
              else if (
                !(
                  result.confirmations ||
                  result.confirmationStatus === 'confirmed' ||
                  result.confirmationStatus === 'finalized'
                )
              ) {
                console.log('REST not confirmed', txid, result);
              } else {
                console.log('REST confirmed', txid, result);
                done = true;
                resolve(result);
              }
            }
          } catch (e) {
            if (!done) {
              console.log('REST connection error: txid', txid, e);
            }
          }
        })();
        await sleep(300);
      }
    })();
  });
  done = true;
  return result;
}
