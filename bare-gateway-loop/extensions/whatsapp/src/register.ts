// Bundled-plugin registration. Real origin: the plugin manifest + bundled
// catalog wiring that makes `whatsappPlugin` discoverable. Importing this file
// for its side effect registers the plugin into the channel catalog.
import { registerChannelPlugin } from "openclaw/channels/plugins/catalog.js";
import { whatsappPlugin } from "./channel.js";

registerChannelPlugin(whatsappPlugin);
