// Importing this file for its side effect registers the cli plugin.
import { registerChannelPlugin } from "openclaw/channels/plugins/catalog.js";
import { cliPlugin } from "./channel.js";

registerChannelPlugin(cliPlugin);
