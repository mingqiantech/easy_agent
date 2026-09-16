import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigSchema, type config } from "./schema.js";
export function loadConfig(overrides?: Partial<config>): Config {
  const fileConfig = loadConfigFile();
}
