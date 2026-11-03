/**
 * The desktop node's wire types: what a node on a desktop (`apps/node`) says
 * about itself and the commands the server may send it. Shared by the node
 * and the server. Plan: docs/plans/desktop-node.md.
 */
import { z } from 'zod';

/** What a node advertises over mDNS. */
export const DESKTOP_NODE_SERVICE = '_livinglayer-node._tcp.local';
/** The port a node listens on unless told otherwise. */
export const DESKTOP_NODE_PORT = 43440;
/** The wire version in `/info` and the mDNS TXT record. */
export const DESKTOP_NODE_VERSION = 1;

export type DesktopNodeCap = 'display' | 'open' | 'banner';

/** The desktops a node knows how to drive. */
export type DesktopKind = 'kde' | 'gnome' | 'hyprland' | 'x11' | 'macos' | 'unknown';

const httpUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), { message: 'Only http and https pages.' });

export const desktopNodeCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('display'), to: z.enum(['on', 'off']) }).strict(),
  z.object({ kind: z.literal('open'), url: httpUrlSchema, kiosk: z.boolean().optional() }).strict(),
  z
    .object({
      kind: z.literal('banner'),
      title: z.string().trim().min(1).max(80),
      text: z.string().trim().max(400).optional(),
      seconds: z.number().int().min(1).max(120).optional(),
    })
    .strict(),
]);
export type DesktopNodeCommand = z.infer<typeof desktopNodeCommandSchema>;

/** `GET /info`: open to anyone on the network. */
export interface DesktopNodeInfo {
  id: string;
  name: string;
  version: number;
  os: 'linux' | 'macos';
  desktop: DesktopKind;
  caps: DesktopNodeCap[];
  adopted: boolean;
}

/** `GET /status`: what the node last did. It can't read the display, only what it last set. */
export interface DesktopNodeStatus {
  display: 'on' | 'off' | null;
  last: { kind: DesktopNodeCommand['kind']; at: string; ok: boolean; error?: string } | null;
}

export const desktopNodePairSchema = z.object({ by: z.string().trim().min(1).max(80) }).strict();
