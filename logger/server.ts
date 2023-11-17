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
app.post("/latency-init", (req, res) => {
	console.log("POST request received from:", req.ip == "::1" ? "localhost" : req.ip);
	const body = req.body;
	if (body && body.fileName) {
		const fileName = body.fileName;
		res.send("POST request received, logger available");
		if (!getFileStatus(fileName) && !body.segment) {
			// log telemetry string to file when new session starts
			if (fileLogLine("// START //", fileName)) {
				console.log("// Player session started //");
				setFileStatus(fileName, 1);
			} else console.log("Invalid filename provided");
		} else if (!body.segment) {
			fileLogLine("// END //" + "\n" + "// START //", fileName); // log telemetry string to file when new session starts
			console.log("// Player session ended //" + "\n" + "// Player session started //");
		}
	} else {
		res.send("POST request received, logger available");
		if (!getFileStatus("log.txt") && !body.segment) {
			fileLogLine("// START //"); // log telemetry string to file when new session starts
			console.log("// Player session started //");
			setFileStatus("log.txt", 1);
		} else if (!body.segment) {
			fileLogLine("// END //" + "\n" + "// START //"); // log telemetry string to file when new session starts
			console.log("// Player session ended //" + "\n" + "// Player session started //");
		}
	}
});

//POST response for localhost:/latency-data
app.post("/latency-data", (req, res) => {
	const dest = req.body.data;
	const filename = req.body.fileName;
	if (
		dest &&
		dest.object != undefined &&
		dest.group != undefined &&
		dest.track != undefined &&
		dest.latency != undefined
	) {
		// create log string
		const str = dest.track + " " + dest.group + " " + dest.object + " " + dest.latency;
		fileLogLine(str, filename); // log telemetry string to file
		// log telemetry data to console
		console.log(
			"Latency for object " +
				dest.object +
				" of group " +
				dest.group +
				" of track " +
				dest.track +
				" : " +
				dest.latency +
				" ms",
		);
	} else console.log("Unexpected data format :", req.body); // log raw data to console if unexpected format
	res.send("Received POST request for telemetry data");
});

//POST response for localhost:/skipped-segment
app.post("/skipped-segment", (req, res) => {
	if (req.body) {
		if (req.body.id != undefined && req.body.reason != undefined) {
			const id = req.body.id;
			const reason = req.body.reason;
			const filename = req.body.fileName;
			// create log string
			const str = "-1 " + id + " 0 " + reason;
			fileLogLine(str, filename); // log telemetry string to file
			// log telemetry data to console
			console.log("Skipped segment", id, ":", reason);
		} else console.log("Unexpected data format :", req.body); // log raw data to console if unexpected format
		res.send("Received POST request for telemetry data");
	}
});

//POST response for localhost:/latency-data-end
app.post("/latency-data-end", (req, res) => {
	const dest = req.body;
	if (dest.playerClosed) {
		fileLogLine("/n" + "// Player session ended //"); // log data to file
		console.log("// Player session ended //"); // log data to console
	} else console.log("Mmmmmmm");
	res.send("Received POST request for telemetry data session end");
});

//POST response for localhost:/latency-string
app.post("/latency-string", (req, res) => {
	const dest = req.body;
	if (dest.str) fileLogLine(dest.str); // log telemetry data to file
	console.log(req.body); // log telemetry data to console
	res.send("Received POST request for telemetry data");
});

//listen on specified port
app.listen(port, () => {
	console.log("Logger listening on port 3000!");
});
