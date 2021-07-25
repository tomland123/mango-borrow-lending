import { PublicKey } from '@solana/web3.js';

export function floorToDecimal(
  value: number,
  decimals: number | undefined | null,
) {
  return decimals
    ? Math.floor(value * 10 ** decimals) / 10 ** decimals
    : Math.floor(value);
}

export const tokenPrecision = {
  BTC: 4,
  ETH: 3,
  SOL: 2,
  SRM: 2,
  USDC: 2,
  USDT: 2,
  WUSDT: 2,
};
export function ceilToDecimal(
  value: number,
  decimals: number | undefined | null,
) {
  return decimals
    ? Math.ceil(value * 10 ** decimals) / 10 ** decimals
    : Math.ceil(value);
}

export const serumMarketId = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
export const serumMarket = new PublicKey(serumMarketId);
