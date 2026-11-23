/**
 * Brand UI library — hand-built components on the SwarmAgents brand system
 * (Void Navy / Signal Cyan / cursor-eye mark; see tokens.css + BRAND.md).
 *
 * Import tokens.css once at the app root, then use the components:
 *
 *   import { ChatBar, VmViewport, PrimaryButton } from "./components/brand";
 */

export { Icon, type IconProps } from "./Icon";
export {
  PrimaryButton,
  GhostButton,
  type BrandButtonProps,
  type ButtonSize,
} from "./Button";
export { Card, type CardProps } from "./Card";
export { StatusPill, type PillStatus, type StatusPillProps } from "./StatusPill";
export { ChatBar, type ChatBarProps } from "./ChatBar";
export { TakeoverButton, type Driver, type TakeoverButtonProps } from "./TakeoverButton";
export { VmViewport, type VmViewportProps } from "./VmViewport";
export { EmptyState, type EmptyStateProps, type StarterTask } from "./EmptyState";
export { LoadingState, Skeleton, Spinner, type LoadingStateProps } from "./LoadingState";
export { SettingsPanel, type SettingsPanelProps } from "./SettingsPanel";
export { Toast, ToastViewport, type ToastData, type ToastTone } from "./Toast";
export {
  BRAND_COLORS,
  STATUS_COLORS,
  BRAND_MOTION_MS,
  BRAND_SPACING,
  ICON_NAMES,
  ICON_SPRITE_HREF,
  type BrandColor,
  type IconName,
} from "./tokens";
