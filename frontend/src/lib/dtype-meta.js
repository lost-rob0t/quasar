import {
  AtSign,
  BookOpen,
  Boxes,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  CircleDot,
  CircleDollarSign,
  CreditCard,
  Database,
  FileText,
  Fingerprint,
  FlaskConical,
  FolderOpen,
  Gavel,
  GitBranch,
  Globe,
  GraduationCap,
  HeartPulse,
  Image,
  Landmark,
  Layers,
  Lightbulb,
  Link2,
  Mail,
  MapPin,
  MessageSquare,
  Microscope,
  Network,
  Newspaper,
  Phone,
  Radio,
  Satellite,
  Scale,
  ScrollText,
  Server,
  ShieldAlert,
  ShoppingCart,
  Tag,
  UserRound,
  Users,
  Video,
  Wallet
} from "lucide-react";
import { dtypeLabel } from "./schema-form";

// Operator ordering directive: COMMON types first, long tail alphabetical.
const COMMON_DTYPE_ORDER = Object.freeze([
  "person",
  "org",
  "social-media-post",
  "user",
  "relation",
  "url",
  "event",
  "location",
  "entity",
  "document",
  "source",
  "target",
  "host",
  "email-message",
  "phone",
  "concept"
]);

const DTYPE_ICONS = Object.freeze({
  person: UserRound,
  org: Building2,
  "social-media-post": MessageSquare,
  user: AtSign,
  relation: Network,
  url: Link2,
  event: CalendarDays,
  location: MapPin,
  entity: CircleDot,
  document: FileText,
  source: BookOpen,
  concept: Lightbulb,
  "research-node": Network,
  target: Fingerprint,
  "investigation-target": Fingerprint,
  "dataset-manifest": Database,
  "actor-manifest": Layers,
  address: MapPin,
  alert: ShieldAlert,
  analysis: Microscope,
  asset: Boxes,
  breach: ShieldAlert,
  "campaign-finance": Wallet,
  claim: ScrollText,
  contract: ScrollText,
  domain: Globe,
  education: GraduationCap,
  email: Mail,
  "email-message": Mail,
  employment: Briefcase,
  "evidence-record": FolderOpen,
  file: FileText,
  "financial-observation": CircleDollarSign,
  geo: Globe,
  grant: Wallet,
  host: Server,
  image: Image,
  media: Video,
  meeting: Users,
  message: MessageSquare,
  network: Radio,
  observation: Microscope,
  operation: GitBranch,
  ownership: Scale,
  phone: Phone,
  policy: ScrollText,
  procurement: ShoppingCart,
  product: Tag,
  "research-pass": FlaskConical,
  task: Layers
});

const FALLBACK_ICON = CircleDot;

export function dtypeIcon(dtype) {
  return DTYPE_ICONS[dtype] || FALLBACK_ICON;
}

function alphabetical(left, right) {
  return dtypeLabel(left).localeCompare(dtypeLabel(right)) || left.localeCompare(right);
}

export function dtypesOrdered(allDtypes) {
  const known = new Set(allDtypes);
  const common = COMMON_DTYPE_ORDER.filter((dtype) => known.has(dtype));
  const tail = [...allDtypes].filter((dtype) => !common.includes(dtype)).sort(alphabetical);
  return [...common, ...tail];
}
