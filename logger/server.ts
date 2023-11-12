import express from "express";
import { fileLog, fileLogLine } from "./api/logger";
const app = express();
const port = 3000;

fileLogLine("test");

app.get("/", (req, res) => {
	res.send("Hello World!");
});

app.listen(port, () => {
	return console.log(`Express is listening at http://localhost:${port}`);
});
