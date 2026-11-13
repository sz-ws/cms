// Command table entries for plugins (besides `plugin add`, in commands.ts) and
// `upgrade`. Part of the one table in commands.ts.

import { DEFAULT_TEMPLATE } from "../create.js";
import { DEFAULT_SOURCE } from "../registry.js";
import type { CommandSpec } from "./spec.js";

const SITE = ["CONFIG_MISSING", "CONFIG_INVALID"];
const id = [{ name: "id", required: true, summary: "an installed plugin's id (directory in extensions/)" }];

export const PLUGIN_COMMANDS_MORE: readonly CommandSpec[] = [
  {
    name: "plugin list",
    summary: "Code plugins compiled in (version, update, settings) and declarative plugins on the live site",
    notes: ["Declarative plugins come from the site database (read-only) and are managed in the admin. Without a login or a deployed Worker, only code plugins are listed, with a warning."],
    positionals: [],
    flags: [{ name: "source", type: "string", valueName: "url", default: DEFAULT_SOURCE, summary: "registry to compare versions with (read without a token)" }],
    mutates: "none",
    examples: ["cms plugin list", "cms plugin list --json"],
    exitCodes: [0, 1, 2],
    errorCodes: SITE,
    parser: "table",
  },
  {
    name: "plugin configure",
    summary: "Answer an installed code plugin's settings again (the interview of plugin add)",
    notes: ["Non-interactive: INPUT_REQUIRED lists the required settings that are empty."],
    positionals: id,
    flags: [],
    mutates: "local",
    examples: ["cms plugin configure shop", "cms plugin configure shop --json"],
    exitCodes: [0, 1, 2, 3, 130],
    errorCodes: [...SITE, "PLUGIN_NOT_FOUND", "INPUT_REQUIRED"],
    parser: "table",
  },
  {
    name: "plugin remove",
    summary: "Remove a code plugin's files and its registry.ts entry",
    notes: ["Its tables and data stay in the database; the live site keeps it until the next cms deploy."],
    positionals: id,
    flags: [
      { name: "dry-run", type: "boolean", summary: "show the files; change nothing" },
      { name: "yes", short: "y", type: "boolean", summary: "accept without asking" },
    ],
    mutates: "local",
    examples: ["cms plugin remove blog --dry-run", "cms plugin remove blog --yes --json"],
    exitCodes: [0, 1, 2, 3, 130],
    errorCodes: [...SITE, "PLUGIN_NOT_FOUND", "CONFIRMATION_REQUIRED", "CANCELLED"],
    parser: "table",
  },
  {
    name: "upgrade",
    summary: "Compare the site's core with the newest core of the template (read-only for now)",
    notes: ["Reads the template with a shallow clone into a temporary folder that is removed afterwards. Changes no file."],
    positionals: [],
    flags: [{ name: "template", type: "string", valueName: "url", default: DEFAULT_TEMPLATE, env: "SZWS_CMS_TEMPLATE", summary: "template git URL" }],
    mutates: "none",
    examples: ["cms upgrade", "cms upgrade --json"],
    exitCodes: [0, 1, 2, 3],
    errorCodes: ["CLONE_FAILED", "GIT_MISSING"],
    parser: "table",
  },
];
