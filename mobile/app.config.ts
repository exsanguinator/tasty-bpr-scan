import { config as loadEnv } from "dotenv";
import path from "path";

import type { ExpoConfig } from "expo/config";

// Credentials are baked into the build from the repo-root .env. Anyone with the
// APK can extract them, which is acceptable for sideloading to your own phones
// only -- do not share the built APK.
loadEnv({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const config: ExpoConfig = {
  name: "Put BP Scan",
  slug: "put-bp-scan",
  version: "1.0.0",
  // "default" follows the device auto-rotate setting rather than pinning portrait.
  orientation: "default",
  icon: "./assets/icon.png",
  // "automatic" is required for useColorScheme() to report the device setting;
  // pinning it to "light" would make the Theme > System option a no-op.
  userInterfaceStyle: "automatic",
  android: {
    package: "com.exsanguinator.putbpscan",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  extra: {
    tastyEnv: process.env.TASTY_ENV ?? "prod",
    clientSecret: process.env.TASTY_CLIENT_SECRET ?? null,
    refreshToken: process.env.TASTY_REFRESH_TOKEN ?? null,
  },
};

export default config;
