import express from "express";
import cors from "cors";
import { fileLog, fileLogLine } from "./api/logger";

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
	console.log(req.body);
	res.send("Got a GET request");
});
//POST response for localhost:/latency-data
app.post("/latency-data", (req, res) => {
	const dest = req.body;
	if (
		dest &&
		dest.object != undefined &&
		dest.group != undefined &&
		dest.track != undefined &&
		dest.latency != undefined
	) {
		const str = dest.track + " " + dest.group + " " + dest.object + " " + dest.latency;
		fileLogLine(str); // log telemetry data to file
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
		); // log raw telemetry data to console
	} else console.log("Unexpected data format :", req.body); // log raw telemetry data to console
	res.send("Received POST request for telemetry data");
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
