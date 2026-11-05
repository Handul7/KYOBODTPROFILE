import { getConfig } from "../server.mjs";
const config = await getConfig();
console.log(JSON.stringify({ node: process.version, ...config, note: "사진을 전송하거나 유료 AI를 호출하지 않았습니다. Cloud configured 상태는 키·설정 존재만 의미합니다." }, null, 2));
process.exitCode = config.ready ? 0 : 1;
