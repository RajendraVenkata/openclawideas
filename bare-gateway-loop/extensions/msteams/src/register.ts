// Bundled-plugin registration (same pattern as WhatsApp). Importing this file for
// its side effect registers the MS Teams plugin into the channel catalog.
import { registerChannelPlugin } from "openclaw/channels/plugins/catalog.js";
import { msteamsPlugin } from "./channel.js";

registerChannelPlugin(msteamsPlugin);
