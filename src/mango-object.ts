// @ts-nocheck
import {
  borrowAndWithdraw,
  getSymbolForTokenMintAddress,
  getTokenBalances,
  initMarginAccountAndDeposit,
  settleBorrow,
} from './utils';
import { MangoClient, IDS } from '@blockworks-foundation/mango-client';
import { PublicKey, Connection } from '@solana/web3.js';
import {
  formatTokenMints,
  getOwnedSplTokenAccounts,
  loadSerumMarkets,
} from './utils';

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
    this.prices = undefined;
    this.srmAccountInfo = undefined;
    this.mangoTokenInfo = undefined;
  }

  async getBalances() {
    const { mangoGroup, symbols, client } = this;
    const ownerMarginAccounts = await client?.getMarginAccountsForOwner(
      connection,
      new PublicKey(programId),
      mangoGroupToUse,
      wallet,
    );

    const modifiedOwnerMarginAccounts = ownerMarginAccounts.map((item) => {
      const balances = getTokenBalances({
        item,
        symbols,
        mangoGroup,
      });
      item.balances = balances;
      return item;
    });

    this.ownerMarginAccounts = modifiedOwnerMarginAccounts;
  }

  async settle({ symbolPublicKey, marginAccount, settleQuantity }) {
    const { connection, programId, mangoGroup, wallet } = this;
    await settleBorrow(
      connection,
      programId,
      mangoGroup,
      marginAccount,
      wallet,
      symbolPublicKey,
      settleQuantity,
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
    this.getBalances();
  }
  async settleAllBorrows() {}

  async updateUserWalletData() {
    const ownerMarginAccounts = await this.client.getMarginAccountsForOwner(
      this.connection,
      this.programId,
      this.mangoGroup,
      this.wallet,
    );
    this.ownerMarginAccounts = ownerMarginAccounts;
  }

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
    ].concat(splAccounts);

    const symbolsForAccounts = activeWallets.map((a) =>
      getSymbolForTokenMintAddress(a.account.mint.toString()),
    );

    const missingTokens = Object.keys(symbols).filter(
      (sym) => !symbolsForAccounts.includes(sym),
    );

    this.mangoTokenInfo = { activeWallets, missingTokens };

    return { activeWallets, missingTokens };
  }
  async deposit({ tokenDetail, quantity }) {
    const token = tokenDetail.account.mint;
    const tokenAcc = tokenDetail.publicKey;

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
  getMarkets() {
    const { cluster, programId, mangoGroup, markets } = this;
    const TOKEN_MINTS = formatTokenMints(IDS[cluster].symbols);

    return Object.keys(markets).map(function (marketIndex) {
      const market = markets[marketIndex];
      const marketAddress = market ? market.publicKey.toString() : null;

      const baseCurrency =
        (market?.baseMintAddress &&
          TOKEN_MINTS.find((token) =>
            token.address.equals(market.baseMintAddress),
          )?.name) ||
        '...';

      const quoteCurrency =
        (market?.quoteMintAddress &&
          TOKEN_MINTS.find((token) =>
            token.address.equals(market.quoteMintAddress),
          )?.name) ||
        '...';

      return {
        market,
        marketAddress,
        programId,
        baseCurrency,
        quoteCurrency,
      };
    });
  }

  static async create({
    cluster = 'mainnet-beta',
    mangoGroupName = 'BTC_ETH_SOL_SRM_USDC',
    markets = null,
    payerPriv = null,
    fetchMarkets = true,
    wallet,
  }) {
    const client = new MangoClient();
    const connection = new Connection(IDS.cluster_urls['mainnet-beta']);
    const programId = new PublicKey(IDS['mainnet-beta'].mango_program_id);
    const clusterIds = IDS[cluster];
    const dexProgramId = new PublicKey(clusterIds.dex_program_id);
    const mangoGroupIds = clusterIds.mango_groups[mangoGroupName];
    const symbols = IDS[cluster]?.mango_groups[mangoGroupName]?.symbols;

    let marketsToUse = markets;

    const mangoGroupPk = new PublicKey(
      clusterIds.mango_groups[mangoGroupName].mango_group_pk,
    );
    let mangoGroupToUse = await client.getMangoGroup(connection, mangoGroupPk);
    const serumMarketId = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const serumMarket = new PublicKey(serumMarketId);

    if (!marketsToUse && fetchMarkets) {
      marketsToUse = await loadSerumMarkets({
        url: IDS.cluster_urls['mainnet-beta'],
        accounts: mangoGroupToUse.spotMarkets.map((item) => item.toBase58()),
        serumMarket,
      });
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

    const modifiedOwnerMarginAccounts = ownerMarginAccounts.map((item) => {
      const balances = getTokenBalances({
        item,
        symbols,
        mangoGroup: mangoGroupToUse,
      });
      item.balances = balances;
      return item;
    });

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
