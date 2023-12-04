import { Player } from "../playback/index.js"
import { initLoggerFile } from "../common/logger.js"

// const { initLoggerFile } = require("./common/logger")
import minimist from "minimist"

const argv = minimist(process.argv.slice(2))
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
console.log(argv)
const PUBLIC_RELAY_HOST = "130.192.16.111:4443"
const DEFAULT_ID = 1
const DEFAULT_DURATION = 10000

const server = argv.server ?? PUBLIC_RELAY_HOST
const id = argv.id ?? DEFAULT_ID

const today = new Date()
const date = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate()
const time = today.getHours() + "." + today.getMinutes() + "." + today.getSeconds()
const dateTime = date + "_" + time
const loggerFileName = argv.logName ?? "log_" + dateTime + ".txt"
initLoggerFile("Publisher", loggerFileName) // init logger server and check status
const url = `https://${server}/${id}`

// Special case localhost to fetch the TLS fingerprint from the server.
// TODO remove this when WebTransport correctly supports self-signed certificates
const fingerprint = server ? `https://${server}/fingerprint` : undefined
function delay() {
	return new Promise((resolve) => setTimeout(resolve, DEFAULT_DURATION))
}
await Player.create({ url, fingerprint, logger: loggerFileName }).then(async (player) => {
	await delay()
	await player.close()
})
