const assert = require("assert")
const Contract = require("@truffle/contract")

const {
  deployFleetOfSafes,
  fetchTokenInfoFromExchange,
  buildTransferApproveDepositFromOrders,
  buildOrders,
  checkSufficiencyOfBalance,
  isOnlySafeOwner,
  hasExistingOrders,
} = require("./utils/trading_strategy_helpers")(web3, artifacts)
const { isPriceReasonable, areBoundsReasonable } = require("./utils/price_utils")(web3, artifacts)
const { signAndSend } = require("./utils/sign_and_send")(web3, artifacts)
const { proceedAnyways } = require("./utils/user_interface_helpers")
const { toErc20Units } = require("./utils/printing_tools")
const { sleep } = require("./utils/js_helpers")

const argv = require("./utils/default_yargs")
  .option("masterSafe", {
    type: "string",
    describe: "Address of Gnosis Safe owning every bracket",
    demandOption: true,
  })
  .option("fleetSize", {
    type: "int",
    default: 20,
    describe: "Even number of brackets to be deployed",
  })
  .option("brackets", {
    type: "string",
    describe: "Trader account addresses to place orders on behalf of",
    coerce: (str) => {
      return str.split(",")
    },
  })
  .option("baseTokenId", {
    type: "int",
    describe: "Token whose target price is to be specified (i.e. ETH)",
    demandOption: true,
  })
  .option("depositBaseToken", {
    type: "string",
    describe: "Amount to be invested into the baseToken",
    demandOption: true,
  })
  .option("quoteTokenId", {
    type: "int",
    describe: "Trusted Quote Token for which to open orders (i.e. DAI)",
    demandOption: true,
  })
  .option("depositQuoteToken", {
    type: "string",
    describe: "Amount to be invested into the quoteToken",
    demandOption: true,
  })
  .option("currentPrice", {
    type: "float",
    describe: "Price at which the brackets will be centered (e.g. current price of ETH in USD)",
    demandOption: true,
  })
  .option("lowestLimit", {
    type: "float",
    describe: "Price for the bracket buying with the lowest price",
  })
  .option("highestLimit", {
    type: "float",
    describe: "Price for the bracket selling at the highest price",
  })
  .option("verify", {
    type: "boolean",
    default: false,
    describe: "Do not actually send transactions, just simulate their submission",
  })
  .option("nonce", {
    type: "int",
    describe: "Use this specific nonce instead of the next available one",
  }).argv

module.exports = async (callback) => {
  try {
    // Init params
    const GnosisSafe = artifacts.require("GnosisSafe")
    const masterSafe = await GnosisSafe.at(argv.masterSafe)
    const BatchExchange = Contract(require("@gnosis.pm/dex-contracts/build/contracts/BatchExchange"))
    BatchExchange.setProvider(web3.currentProvider)
    const exchange = await BatchExchange.deployed()

    const tokenInfoPromises = fetchTokenInfoFromExchange(exchange, [argv.baseTokenId, argv.quoteTokenId])
    const baseTokenData = await tokenInfoPromises[argv.baseTokenId]
    const quoteTokenData = await tokenInfoPromises[argv.quoteTokenId]
    const { instance: baseToken, decimals: baseTokenDecimals } = baseTokenData
    const { instance: quoteToken, decimals: quoteTokenDecimals } = quoteTokenData

    const depositBaseToken = toErc20Units(argv.depositBaseToken, baseTokenDecimals)
    const depositQuoteToken = toErc20Units(argv.depositQuoteToken, quoteTokenDecimals)

    if (argv.brackets) {
      assert(argv.fleetSize === argv.brackets.length, "Please ensure fleetSize equals number of brackets")
    }
    assert(argv.fleetSize % 2 === 0, "Fleet size must be a even number for easy deployment script")

    console.log("==> Performing safety checks")
    if (!(await checkSufficiencyOfBalance(baseToken, masterSafe.address, depositBaseToken))) {
      callback(`Error: MasterSafe has insufficient balance for the token ${baseToken.address}.`)
    }
    if (!(await checkSufficiencyOfBalance(quoteToken, masterSafe.address, depositQuoteToken))) {
      callback(`Error: MasterSafe has insufficient balance for the token ${quoteToken.address}.`)
    }
    // check price against dex.ag's API
    const priceCheck = await isPriceReasonable(baseTokenData, quoteTokenData, argv.currentPrice)
    if (!priceCheck) {
      if (!(await proceedAnyways("Price check failed!"))) {
        callback("Error: Price checks did not pass")
      }
    }
    const boundCheck = areBoundsReasonable(argv.currentPrice, argv.lowestLimit, argv.highestLimit)
    if (!boundCheck) {
      if (!(await proceedAnyways("Bound checks failed!"))) {
        callback("Error: Bound checks did not pass")
      }
    }
    if (argv.fleetSize > 23) {
      callback("Error: Choose a smaller fleetSize, otherwise your payload will be to big for Infura nodes")
    }

    let bracketAddresses
    if (argv.brackets) {
      console.log("==> Skipping safe deployment and using brackets safeOwners")
      bracketAddresses = argv.brackets
      // Ensure that safes are all owned solely by masterSafe
      await Promise.all(
        bracketAddresses.map(async (safeAddr) => {
          if (!(await isOnlySafeOwner(masterSafe.address, safeAddr))) {
            callback(`Error: Bracket ${safeAddr} is not owned (or at least not solely) by master safe ${masterSafe.address}`)
          }
        })
      )
      // Detect if provided brackets have existing orders.
      const existingOrders = await Promise.all(
        bracketAddresses.map(async (safeAddr) => {
          return hasExistingOrders(safeAddr, exchange)
        })
      )
      const dirtyBrackets = bracketAddresses.filter((_, i) => existingOrders[i] == true)
      if (
        existingOrders.some((t) => t) &&
        !(await proceedAnyways(`The following brackets have existing orders:\n  ${dirtyBrackets.join()}\n`))
      ) {
        callback("Error: Existing order verification failed.")
      }
    } else {
      assert(!argv.verify, "Trading Brackets need to be provided via --brackets when verifying a transaction")
      console.log(`==> Deploying ${argv.fleetSize} trading brackets`)
      bracketAddresses = await deployFleetOfSafes(masterSafe.address, argv.fleetSize)
      // Sleeping for 3 seconds to make sure Infura nodes have processed
      // all newly deployed contracts so they can be awaited.
      await sleep(3000)
    }

    console.log("==> Building orders and deposits")
    const orderTransaction = await buildOrders(
      masterSafe.address,
      bracketAddresses,
      argv.baseToken,
      argv.quoteToken,
      argv.lowestLimit,
      argv.highestLimit,
      true
    )
    const bundledFundingTransaction = await buildTransferApproveDepositFromOrders(
      masterSafe.address,
      bracketAddresses,
      baseToken.address,
      quoteToken.address,
      argv.lowestLimit,
      argv.highestLimit,
      argv.currentPrice,
      depositQuoteToken,
      depositBaseToken,
      true
    )

    console.log(
      "==> Sending the order placing transaction to gnosis-safe interface.\n    Attention: This transaction MUST be executed first!"
    )
    let nonce = argv.nonce
    if (nonce === undefined) {
      nonce = (await masterSafe.nonce()).toNumber()
    }
    await signAndSend(masterSafe, orderTransaction, argv.network, nonce, argv.verify)

    console.log(
      "==> Sending the funds transferring transaction.\n    Attention: This transaction can only be executed after the one above!"
    )
    await signAndSend(masterSafe, bundledFundingTransaction, argv.network, nonce + 1, argv.verify)

    if (!argv.verify) {
      console.log(
        `To verify the transactions run the same script with --verify --nonce=${nonce} --brackets=${bracketAddresses.join()}`
      )
    }

    callback()
  } catch (error) {
    callback(error)
  }
}
