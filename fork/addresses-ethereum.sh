# Aave V3 Ethereum (core market) addresses. Pool and tokens: bgd-labs aave-address-book
# (AaveV3Ethereum.sol); the AddressesProvider and oracle were read from the Pool on chain
# (Pool.ADDRESSES_PROVIDER(), provider.getPriceOracle(); POOL_REVISION() = 11). Public data.
export AAVE_POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
export AAVE_POOL_ADDRESSES_PROVIDER=0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
export AAVE_ORACLE=0x54586bE62E3c3580375aE3723C145253060Ca0C2
# no faucet on mainnet: wallets are funded by hand (on a local copy, by writing token balances)
export WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
export USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
# anvil dev account #0: public, well-known test account; only ever used on a local copy
export FORK_ADMIN=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
