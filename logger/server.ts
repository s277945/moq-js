import express from "express";
import cors from "cors";
import { fileLog, fileLogLine } from "./api/logger";
import { setFileStatus, getFileStatus } from "./api/file_status";

const app = express();
//enable cors for localhost app
app.use(
	cors({
		origin: ["https://localhost", "http://localhost", "https://localhost:4321"],
	}),
);
app.use(express.json());
const port = 3000;

//GET response for localhost:/latency-data
app.get("/latency-data", (req, res) => {
	console.log("GET request received from:", req.ip == "::1" ? "localhost" : req.ip);
	res.send("GET request received, logger available");
});

//POST response for localhost:/latency-init
app.post("/log-init", (req, res) => {
	//console.log("POST request received from:", req.ip == "::1" ? "localhost" : req.ip);
	const body = req.body;
	if (body && body.role && body.fileName) {
		const fileName = body.fileName;
		res.send("POST request received, logger available");
		// log telemetry string to a new file when new session starts
		if (getFileStatus(fileName) != 2 && !body.segment) {
			// if file is not initialized in this session, write file header line
			if (!getFileStatus(fileName) && fileLogLine("Track ID;Object ID;Group ID;Status;Latency/Jitter;", fileName))
				console.log("Writing to file:", fileName);
			else if (!getFileStatus(fileName)) {
				console.log("Invalid filename provided"); // failed to create new file
				return;
			}
			if (body.role == "Subscriber") {
				// if subscriber log init, log subscriber start and set status to 2
				setFileStatus(fileName, 2);
				fileLogLine("-;-;-;SUBSCRIBER START;-;", fileName);
				console.log("// Subscriber session started //");
			} else if (body.role == "Publisher") {
				// if publisher log init, log publisher start and set status to 2
				setFileStatus(fileName, 1);
				console.log("// Publisher session started //");
				fileLogLine("-;-;-;PUBLISHER START;-;", fileName);
			}
		} else if (!body.segment && body.role == "Subscriber") {
			// for now one subscriber at a time for a file
			fileLogLine("-;-;-;SUBSCRIBER RESTART;-;", fileName); // log telemetry string to file when new session starts
		}
	} else {
		// log filename not specified
		res.send("POST request received, logger available");
		if (getFileStatus("log.txt") != 2 && !body.segment) {
			// if file is not initialized in this session, write file header line
			if (
				!getFileStatus("log.txt") &&
				fileLogLine("Track ID;Object ID;Group ID;Status;Latency/Jitter;", "log.txt")
			)
				console.log("Writing to file:", "log.txt");
			else if (!getFileStatus("log.txt")) {
				console.log("Invalid filename provided"); // failed to create new file
				return;
			}
			if (body.role == "Subscriber") {
				// if subscriber log init, log subscriber start and set status to 2
				setFileStatus("log.txt", 2);
				fileLogLine("-;-;-;SUBSCRIBER START;-;", "log.txt");
				console.log("// Subscriber session started //");
			} else if (body.role == "Publisher") {
				// if publisher log init, log publisher start and set status to 2
				setFileStatus("log.txt", 1);
				console.log("// Publisher session started //");
				fileLogLine("-;-;-;PUBLISHER START;-;", "log.txt");
			}
		} else if (!body.segment && body.role == "Subscriber") {
			// for now one subscriber at a time for a file
			fileLogLine("-;-;-;SUBSCRIBER RESTART;-;", "log.txt"); // log telemetry string to file when new session starts
		}
	}
});

//POST response for localhost:/latency-data
app.post("/log-data", (req, res) => {
	const data = req.body.data;
	const filename = req.body.fileName;
	if (data && data.object != undefined && data.group != undefined && data.track != undefined) {
		// create log string
		let str = "";
		if (data.status != undefined || data.latency != undefined)
			str += data.track + ";" + data.object + ";" + data.group;
		if (data.status != undefined) {
			str += ";" + data.status;
			if (data.status === "sent")
				if (data.jitter != undefined) {
					str += ";" + data.jitter;
					console.log(
						"Sent object",
						data.object +
							" of group " +
							data.group +
							" of track " +
							data.track +
							", sender jitter: " +
							data.jitter,
					);
				} else console.log("Sent object", data.object + " of group " + data.group + " of track " + data.track);
		}
		if (data.latency != undefined) {
			str += ";" + data.latency;
			console.log(
				"Latency for object",
				data.object +
					" of group " +
					data.group +
					" of track " +
					data.track +
					(data.latency ? " : " + data.latency + " ms" : ""),
			);
		} else if (data.sender_ts != undefined && data.receiver_ts != undefined) {
			const latency = data.receiver_ts > data.sender_ts ? data.receiver_ts - data.sender_ts : undefined;
			str += ";" + latency;
			console.log(
				"Latency for object",
				data.object +
					" of group " +
					data.group +
					" of track " +
					data.track +
					(latency ? " : " + latency + " ms" : "could not be computed"),
			);
		}
		if (str !== "") fileLogLine(str, filename); // log telemetry string to file
		// log telemetry data to console
	} else console.log("Unexpected data format :", req.body); // log raw data to console if unexpected format
	res.send("Received POST request for telemetry data");
});

//POST response for localhost:/skipped-segment
app.post("/skipped-segment", (req, res) => {
	if (req.body) {
		if (req.body.id != undefined && req.body.reason != undefined) {
			const id = req.body.id;
			const reason = req.body.reason;
			const track = req.body.track;
			const filename = req.body.fileName;
			// create log string
			const str = track + ";0;" + id + ";" + reason;
			fileLogLine(str, filename); // log telemetry string to file
			// log telemetry data to console
			console.log("Skipped segment", id, "of track", track, ":", reason);
		} else console.log("Unexpected data format :", req.body); // log raw data to console if unexpected format
		res.send("Received POST request for telemetry data");
	}
});

//POST response for localhost:/latency-data-end
app.post("/log-end", (req, res) => {
	const data = req.body;
	if (data.playerClosed) {
		fileLogLine("/n" + "// Player session ended //"); // log data to file
		console.log("// Player session ended //"); // log data to console
	} else console.log("Mmmmmmm");
	res.send("Received POST request for telemetry data session end");
});

//POST response for localhost:/latency-string
app.post("/latency-string", (req, res) => {
	const data = req.body;
	if (data.str) fileLogLine(data.str); // log telemetry data to file
	console.log(req.body); // log telemetry data to console
	res.send("Received POST request for telemetry data");
});

//listen on specified port
app.listen(port, () => {
	console.log("Logger listening on port 3000!");
});
