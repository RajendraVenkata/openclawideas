// Importing this file for its side effect registers the webhook plugin.
import { registerChannelPlugin } from "openclaw/channels/plugins/catalog.js";
import { webhookPlugin } from "./channel.js";

registerChannelPlugin(webhookPlugin);
