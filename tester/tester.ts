import puppeteer from "puppeteer";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

(async () => {
	const browser = await puppeteer.launch({
		executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		headless: "new",
		defaultViewport: null,
		devtools: true,
		args: [
			"--window-size=1920,1080",
			"--window-position=0,0",
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			"--use-file-for-fake-video-capture=H:/Tesi/moq-js/moq-js/tester/sample.mjpeg",
			"--use-file-for-fake-audio-capture=H:/Tesi/moq-js/moq-js/tester/test.wav",
			"--autoplay-policy=no-user-gesture-required",
		],
	});
	// const browser = await puppeteer.launch({
	// 	args: [
	// 		"--use-fake-ui-for-media-stream",
	// 		"--use-fake-device-for-media-stream",
	// 		// "--use-file-for-fake-video-capture=H:/Tesi/moq-js/moq-js/tester/sample.mjpeg",
	// 		// "--use-file-for-fake-audio-capture=H:/Tesi/moq-js/moq-js/tester/CantinaBand3.wav",
	// 		// "--allow-file-access",
	// 	],
	// });
	const context = browser.defaultBrowserContext();
	const page = await browser.newPage();
	await page.goto("https://localhost:4321/publish");
	await context.overridePermissions("https://localhost:4321", [
		"clipboard-read",
		"clipboard-write",
		"clipboard-sanitized-write",
	]);
	try {
		await page.waitForSelector("#cameraButton", { timeout: 1000 });
	} catch (e) {
		console.log("Could not start input device: timeout");
	}
	const selectCameraButton = await page.$("#buttonWindow");
	await selectCameraButton?.click();
	try {
		await page.waitForSelector("#startButton", { timeout: 1000 });
	} catch (e) {
		console.log("Could not start stream: timeout");
	}
	const startStreamButton = await page.$("#startButton");
	if (startStreamButton != null) {
		await startStreamButton?.click();
		try {
			await page.waitForSelector("#shareButton", { timeout: 1000 });
		} catch (e) {
			await startStreamButton?.click();
		}
		try {
			await page.waitForSelector("#shareButton", { timeout: 1000 });
		} catch (e) {
			console.log("Could not start stream: timeout");
			await startStreamButton?.click();
		}
		const getLinkButton = await page.$("#shareButton");
		if (getLinkButton != null) {
			await getLinkButton.click();
			const copiedText = String(await page.evaluate(`(async () => await navigator.clipboard.readText())()`));
			console.log("Started broadcast", copiedText);
			const newpage = await browser.newPage();
			await newpage.goto(copiedText);
		} else console.log("Could not start stream");
	}
	await page.screenshot({ path: "screenshot.png" });
	await delay(30000);
	await browser.close();
})();
