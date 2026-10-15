import type { DatabaseSync } from "node:sqlite";

export function buildSynthCorpus(opts?: { file?: string; sessions?: number; days?: number; seed?: number; rowBytes?: number }): DatabaseSync;
