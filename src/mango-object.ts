// @ts-nocheck
import {
  borrowAndWithdraw,
  deposit,
  getBalances,
  getMarkets,
  getSymbolForTokenMintAddress,
  initMarginAccountAndDeposit,
  formatTokenMints,
  getOwnedSplTokenAccounts,
  loadSerumMarkets,
} from './utils';
import { serumMarket } from './variables';
import { MangoClient, IDS } from '@blockworks-foundation/mango-client';
import { PublicKey, Connection } from '@solana/web3.js';

import _ from 'lodash';
import { WRAPPED_SOL_MINT } from '@project-serum/serum/lib/token-instructions';

export class MangoBorrowLending {
  constructor(
    client,
    cluster,
    mangoGroupName,
    connection,
    programId,
    dexProgramId,
    mangoGroup,
    markets,
    mangoGroupTokenMappings,
    spotMarketMappings,
    payerPriv,
    wallet,
    symbols,
    ownerMarginAccounts,
  ) {
    this.client = client;
    this.cluster = cluster;
    this.mangoGroupName = mangoGroupName;
    this.connection = connection;
    this.programId = programId;
    this.dexProgramId = dexProgramId;
    this.mangoGroup = mangoGroup;
    this.markets = markets;
    this.mangoGroupTokenMappings = mangoGroupTokenMappings;
    this.spotMarketMappings = spotMarketMappings;
    this.payerPriv = payerPriv;
    this.wallet = wallet;
    this.symbols = symbols;
    this.ownerMarginAccounts = ownerMarginAccounts;

    this.srmAccountInfo = undefined;
    this.mangoTokenInfo = undefined;
  }

  async getBalances() {
    const {
      client,
      programId,
      connection,
      mangoGroup,
      markets,
      wallet,
      symbols,
      cluster,
    } = this;

    const TOKEN_MINTS = formatTokenMints(IDS[cluster].symbols);

    const loadedMarkets = await loadSerumMarkets({
      url: IDS.cluster_urls[cluster],
      accounts: mangoGroup.spotMarkets.map((item) => item.toBase58()),
      serumMarket,
    });

    const marketsToUse = getMarkets(loadedMarkets, TOKEN_MINTS, programId);
    const ownerMarginAccounts = await client.getMarginAccountsForOwner(
      connection,
      programId,
      mangoGroup,
      wallet,
    );

    const tokens = await this.getTokensInWallet();

    const modifiedOwnerMarginAccounts = ownerMarginAccounts.map(
      (marginAccount) => {
        const balances = getBalances({
          markets: marketsToUse,
          marginAccount,
          symbols,
          mangoGroup: mangoGroup,
        });
        const prices = marginAccount.mangoGroup.getPrices(connection);
        marginAccount.prices = prices;
        marginAccount.balances = balances;
        return marginAccount;
      },
    );

    this.markets = markets;
    this.ownerMarginAccounts = modifiedOwnerMarginAccounts;
  }

  async repay({ asset, marginAccount, tokenDetail, settleQuantity }) {
    const { connection, programId, mangoGroup, wallet } = this;
    const { borrows, deposits } = asset;

    if (!borrows) {
      console.error('No borrows');
      return;
    }

    await deposit(
      connection,
      new PublicKey(programId),
      mangoGroup,
      marginAccount,
      wallet,
      token,
      tokenAcc,
      Number(settleQuantity),
    );

    await this.getBalances();
  }

  async withdraw({
    marginAccount,

    token,
    quantity,
  }) {
    const { connection, programId, mangoGroup, wallet } = this;
    await withdraw(
      connection,
      programId,
      mangoGroup,
      marginAccount,
      wallet,
      token,
      quantity,
    );

    this.getBalances();
  }

  async borrow({ marginAccount, token, withdrawQuantity }) {
    const { connection, programId, wallet, mangoGroup } = this;

    await borrowAndWithdraw(
      connection,
      programId,
      mangoGroup,
      marginAccount,
      wallet,
      token,
      withdrawQuantity,
    );
  }
  async settleAllBorrows() {}

  async getTokensInWallet() {
    const splAccounts = await getOwnedSplTokenAccounts(
      this.connection,
      this.wallet.publicKey,
    );
    const symbols =
      IDS[this.cluster]?.mango_groups[this.mangoGroupName]?.symbols;
    const account = await this.connection.getAccountInfo(this.wallet.publicKey);
    if (!account) return Object.keys(symbols);

    const activeWallets = [
      {
        publicKey: this.wallet.publicKey,
        type: getSymbolForTokenMintAddress(WRAPPED_SOL_MINT.toString()),
        account: {
          mint: WRAPPED_SOL_MINT,
          owner: this.wallet.publicKey,
          amount: account.lamports,
        },
      },
    ].concat(
      splAccounts.filter((account) =>
        Object.keys(symbols).includes(account.type),
      ),
    );

    const symbolsForAccounts = activeWallets.map((a) =>
      getSymbolForTokenMintAddress(a.account.mint.toString()),
    );

    const missingTokens = Object.keys(symbols).filter(
      (sym) => !symbolsForAccounts.includes(sym),
    );

    this.mangoTokenInfo = { activeWallets, missingTokens };

    return { activeWallets, missingTokens };
  }

  async deposit({ tokenDetail, quantity, marginAccount }) {
    const token = tokenDetail.account.mint;
    const tokenAcc = tokenDetail.publicKey;

    if (!this?.ownerMarginAccounts?.length && !marginAccount) {
      const marginAccount = await initMarginAccountAndDeposit(
        this.connection,
        IDS[this.cluster].mango_program_id,
        this.mangoGroup,
        this.wallet,
        token,
        tokenAcc,
        quantity,
      );
      return marginAccount;
    } else {
      let marginAccountToUse = marginAccount
        ? marginAccount
        : this?.ownerMarginAccounts?.[0];
      deposit(
        this.connection,
        IDS[this.cluster].mango_program_id,
        this.mangoGroup,
        marginAccountToUse,
        this.wallet,
        token,
        tokenAcc,
        quantity,
      );
    }
  }
  async fetchMangoGroup() {
    const { connection, mangoGroupName, cluster, client } = this;

    const mangoGroupIds = IDS[cluster].mango_groups[mangoGroupName];

    const mangoGroupPk = new PublicKey(mangoGroupIds.mango_group_pk);
    const srmVaultPk = new PublicKey(mangoGroupIds.srm_vault_pk);
    return client
      .getMangoGroup(connection, mangoGroupPk, srmVaultPk)
      .then(async (mangoGroup) => {
        const srmAccountInfoPromise = connection.getAccountInfo(
          mangoGroup.srmVault,
        );
        const pricesPromise = mangoGroup.getPrices(connection);
        const [srmAccountInfo, prices] = await Promise.all([
          srmAccountInfoPromise,
          pricesPromise,
        ]);
        // Set the mango group
        this.prices = prices;
        this.srmAccountInfo = srmAccountInfo;
      });
  }

  getMarginAccount(marginAccount) {
    return marginAccount ? marginAccount : this?.ownerMarginAccounts?.[0];
  }

  static async create({
    cluster = 'mainnet-beta',
    connectionSpeed = 'recent',
    mangoGroupName = 'BTC_ETH_SOL_SRM_USDC',
    markets = null,
    payerPriv = null,
    fetchMarkets = true,
    wallet,
  }) {
    const client = new MangoClient();
    const connection = new Connection(
      IDS.cluster_urls[cluster],
      connectionSpeed,
    );
    const programId = new PublicKey(IDS[cluster].mango_program_id);
    const clusterIds = IDS[cluster];
    const dexProgramId = new PublicKey(clusterIds.dex_program_id);
    const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
    const symbols = IDS[cluster]?.mango_groups[mangoGroupName]?.symbols;
    const TOKEN_MINTS = formatTokenMints(IDS[cluster].symbols);

    let marketsToUse = markets;

    const mangoGroupPk = new PublicKey(
      clusterIds.mango_groups[mangoGroupName].mango_group_pk,
    );
    let mangoGroupToUse = await client.getMangoGroup(connection, mangoGroupPk);

    if (!marketsToUse && fetchMarkets) {
      const loadedMarkets = await loadSerumMarkets({
        url: IDS.cluster_urls['mainnet-beta'],
        accounts: mangoGroupToUse.spotMarkets.map((item) => item.toBase58()),
        serumMarket,
      });

      marketsToUse = getMarkets(loadedMarkets, TOKEN_MINTS, programId);
    }

    const mangoGroupTokenMappings = new Map<TokenSymbol, PublicKey>();
    const mangoGroupSymbols: [string, string][] = Object.entries(
      mangoGroupIds.symbols,
    );
    for (const [tokenName, tokenMint] of mangoGroupSymbols) {
      mangoGroupTokenMappings[tokenName] = new PublicKey(tokenMint);
    }
    const mangoGroupSportMarketMappings = new Map<
      SpotMarketSymbol,
      PublicKey
    >();
    const mangoGroupSpotMarketSymbols: [SpotMarketSymbol, string][] =
      Object.entries(mangoGroupIds.spot_market_symbols);
    for (const [spotMarketSymbol, address] of mangoGroupSpotMarketSymbols) {
      mangoGroupSportMarketMappings[spotMarketSymbol] = new PublicKey(address);
    }

    const ownerMarginAccounts = await client.getMarginAccountsForOwner(
      connection,
      programId,
      mangoGroupToUse,
      wallet,
    );

    const modifiedOwnerMarginAccounts = ownerMarginAccounts.map(
      (marginAccount) => {
        const balances = getBalances({
          markets: marketsToUse,
          marginAccount,
          symbols,
          mangoGroup: mangoGroupToUse,
        });
        const prices = marginAccount.mangoGroup.getPrices(connection);
        marginAccount.prices = prices;

        marginAccount.balances = balances;
        return marginAccount;
      },
    );

    return new MangoBorrowLending(
      client,
      cluster,
      mangoGroupName,
      connection,
      programId,
      dexProgramId,
      mangoGroupToUse,
      marketsToUse,
      mangoGroupTokenMappings,
      mangoGroupSportMarketMappings,
      payerPriv,
      wallet,
      symbols,
      modifiedOwnerMarginAccounts,
    );
  }
}
