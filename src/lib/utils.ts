// Shared utilities — re-exports from wizard/utils + cn helper
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Re-export wizard utils for pages that need them
export {
  networkFromJSON, networkMountpointFromJSON, mountpointFromJSON,
  userFromJSON, groupFromJSON, zoneFromJSON, streamFromJSON,
  settingsFromJSON, accountFromJSON, aliasFromJSON,
  networkToJSON, networkMountpointToJSON, mountpointToJSON,
  userToJSON, groupToJSON, zoneToJSON, streamToJSON,
  settingsToJSON, accountToJSON, aliasToJSON,
  generateId,
} from "./wizard/utils";
