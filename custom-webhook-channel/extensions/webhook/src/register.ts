// Importing this file for its side effect registers the webhook plugin.
import { registerChannelPlugin } from "openclaw/channel-sdk.js";
import { webhookPlugin } from "./channel.js";

registerChannelPlugin(webhookPlugin);
