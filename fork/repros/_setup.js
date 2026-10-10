// Shared by every repro: installs Sandom's bundled fonts, so text renders.
import { installBundledSystemFonts } from "sandom/system-fonts.js";
await installBundledSystemFonts();
export { renderComponent } from "sandom/dom/render-component.js";
