const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { dshHome, dshHomePath, setDshHome } = require("../out/dshHome.js");

test("dshHome：扩展配置覆盖优先于进程环境变量", () => {
  const origEnv = process.env.DSH_HOME;
  const override = "C:\\custom\\dsh-home";
  try {
    process.env.DSH_HOME = "C:\\env\\dsh-home";
    setDshHome(override);
    assert.equal(dshHome(), path.resolve(override), "覆盖值应优先");
    assert.equal(dshHomePath("profiles", "headless", "package.json"), path.join(path.resolve(override), "profiles", "headless", "package.json"));
    // 清除覆盖后回到进程环境
    setDshHome(undefined);
    assert.equal(dshHome(), path.resolve("C:\\env\\dsh-home"), "清除覆盖后应回到环境变量");
  } finally {
    setDshHome(undefined);
    if (origEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = origEnv;
  }
});

test("dshHome：无任何配置时兜底 ~/.dsh", () => {
  const origEnv = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    setDshHome(undefined);
    assert.equal(dshHome(), path.join(os.homedir(), ".dsh"));
  } finally {
    if (origEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = origEnv;
  }
});
