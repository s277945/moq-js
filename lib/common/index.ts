export { asError } from "./error"
export {
	getLoggerStatus,
	initLoggerFile,
	getCachedLoggerStatus,
	postLogDataAndForget,
	postSkippedSegmentIdAndForget,
	postLogDataEnd,
	postLogStringAndForget,
	postLogStringAwait,
} from "./logger"
