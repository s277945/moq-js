import { appendFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";

let loggers: Map<string, Logger>;
// loggers is a structure that contains all initialized loggers

export function fileLog(data: any, fileName?: string) {
	//create logger map variable if not already initialized
	if (!loggers) loggers = new Map<string, Logger>();
	let logger: Logger | undefined;

	// prepare logger filename
	const fname = fileName ? fileName : "log.txt";

	// check if logger with same filename has already been initialized
	logger = loggers.get(fname);

	// if not present create one and add it
	if (!logger) {
		logger = createLogger(fname);
		// if filename is invalid return
		if (logger) loggers.set(fname, logger);
		else return;
	}

	// write data to log file
	logger?.write(data);
}

export function fileLogLine(line: string, fileName?: string) {
	fileLog(line + "\n", fileName);
}

function createLogger(fname: string): Logger | undefined {
	// logger variable
	let logger: Logger;

	// check if valid filename is provided
	if (fname && /^[\w,\s-]+\.[A-Za-z0-9]{3}$/i.test(fname)) {
		// create Logger instance
		logger = new Logger(fname);

		// return created logger
		return logger;
	} else console.error("Invalid filename provided for logger file");

	// if filename is invalid return undefined
	return undefined;
}

class Logger {
	private filename: string;

	constructor(fname: string) {
		this.filename = fname;
		writeFileSync(join(dirname(dirname(dirname(__dirname))), this.filename), "", {
			flag: "w",
		});
	}

	public write(data: any) {
		appendFileSync(join(dirname(dirname(dirname(__dirname))), this.filename), data);
	}

	public getFileName() {
		return this.filename;
	}
}
