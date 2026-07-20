/**
 * Static Lucide icon map for info cards — every CARD_ICON_ALLOWLIST key.
 * No dynamic import().
 */

import type { LucideIcon } from 'lucide-react';
import {
  Building,
  Home,
  MapPin,
  User,
  Users,
  Briefcase,
  FileText,
  ChartBar,
  CheckCircle,
  AlertTriangle,
  Info,
  Star,
  Tag,
  Calendar,
  DollarSign,
  Layers,
} from 'lucide-react';
import type { CardIconName } from '../../cards/card-spec.js';

/** Static map — every CARD_ICON_ALLOWLIST key MUST appear. */
export const CARD_ICON_MAP: Record<CardIconName, LucideIcon> = {
  building: Building,
  home: Home,
  'map-pin': MapPin,
  user: User,
  users: Users,
  briefcase: Briefcase,
  'file-text': FileText,
  'chart-bar': ChartBar,
  'check-circle': CheckCircle,
  'alert-triangle': AlertTriangle,
  info: Info,
  star: Star,
  tag: Tag,
  calendar: Calendar,
  'dollar-sign': DollarSign,
  layers: Layers,
};
