import { appendFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import osu from "node-os-utils";

let loggers: Map<string, Logger>;
// loggers is a structure that contains all initialized loggers

const cpu = osu.cpu;
const net = osu.netstat;
let prevCPUTS = 0; // previous saved timestamp for cpu data logging
let prevNetTS = 0; // previous saved timestamp for network data logging
const TSDELTACPU = 100; // cpu data logging interval
const TSDELTANET = 100; // network data logging interval

export interface AdditionalLogConfig {
	cpu?: boolean;
	net?: boolean;
}

export function logAdditionalData(fileName: string, config: AdditionalLogConfig) {
	if (config.cpu) logCPUData(fileName);
	if (config.net) logNetworkData(fileName);
}

export function logCPUData(fileName: string) {
	// function to log CPU usage metrics after a minimum delta of time has passed
	const tsnow = Date.now();
	if (tsnow - prevCPUTS >= TSDELTACPU) {
		cpu.usage().then((cpuPercentage) => {
			console.log("CPU usage at", cpuPercentage, "%");
			const ts = Date.now();
			fileLogLine("-;-;" + ts + ";CPU;" + cpuPercentage, fileName);
		});
		prevCPUTS = tsnow;
	}
}

export function logNetworkData(fileName: string) {
	// function to log CPU usage metrics after a minimum delta of time has passed
	const tsnow = Date.now();
	if (tsnow - prevNetTS >= TSDELTANET) {
		net.stats().then((netData) => {
			console.log("Network usage:", netData);
			// const ts = Date.now();
			// fileLogLine("-;-;" + ts + ";NET;" + netData, fileName);
		});
		prevNetTS = tsnow;
	}
}

export function fileLog(data: any, fileName?: string): boolean {
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
		else return false;
	}

	// write data to log file
	logger?.write(data);
	return true;
}

export function fileLogLine(line: string, fileName?: string): boolean {
	return fileLog(line + "\n", fileName);
}

function createLogger(fname: string): Logger | undefined {
	// logger variable
	let logger: Logger;

	// check if valid filename is provided
	if (fname && /^[a-zA-Z0-9](?:[a-zA-Z0-9 ._-]*[a-zA-Z0-9])?\.[a-zA-Z0-9_-]+$/.test(fname)) {
		// create Logger instance
		logger = new Logger(fname);

		// return created logger
		return logger;
	} else console.error("Invalid filename provided for logger file", ":", fname);

	// if filename is invalid return undefined
	return undefined;
}

class Logger {
	private filename: string;
	private audioId?: number;
	private videoId?: number;

	constructor(fname: string, audioId?: number, videoId?: number) {
		this.filename = fname;
		writeFileSync(join(join(dirname(dirname(dirname(__dirname))), "logs"), this.filename), "", {
			flag: "w",
		});
		this.audioId = audioId;
		this.videoId = videoId;
	}

	public write(data: any) {
		appendFileSync(join(join(dirname(dirname(dirname(__dirname))), "logs"), this.filename), data);
	}

	public getFileName() {
		return this.filename;
	}
}
