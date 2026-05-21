// Type augmentation for Obsidian's internal App.setting surface, which is
// present at runtime but not exposed in the public `obsidian` package types.
// Narrowed to only the methods this plugin actually uses.

import "obsidian";

declare module "obsidian" {
  interface App {
    setting: {
      open(): void;
      openTabById(id: string): void;
    };
  }
}
