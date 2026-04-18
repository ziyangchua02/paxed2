import { createApp } from "./src/app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createApp();

app.listen(port, () => {
  console.log(`Landing page running at http://localhost:${port}`);
});
