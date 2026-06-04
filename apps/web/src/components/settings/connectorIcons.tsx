import type { ComponentType } from "react";
import {
  IconBoxOutline24 as PuzzlePieceIcon,
  IconFolderOutline24 as FolderIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconSparkleOutline24 as BrainIcon,
} from "../../icons/lucideNucleoFallback";
import { SiGithub, SiNotion, SiStripe, SiUpstash, SiVercel } from "react-icons/si";

import type { MarketplaceConnectorId } from "./connectorMarketplace";

type IconComponent = ComponentType<{ className?: string }>;

// Brand icons (Simple Icons via react-icons) where a connector has one, with a
// category-appropriate fallback for connectors without an official mark.
const CONNECTOR_ICONS: Partial<Record<MarketplaceConnectorId, IconComponent>> = {
  github: SiGithub,
  notion: SiNotion,
  stripe: SiStripe,
  vercel: SiVercel,
  context7: SiUpstash,
  filesystem: FolderIcon,
  playwright: GlobeIcon,
  "sequential-thinking": BrainIcon,
};

export function getConnectorIcon(id: string): IconComponent {
  return CONNECTOR_ICONS[id as MarketplaceConnectorId] ?? PuzzlePieceIcon;
}
