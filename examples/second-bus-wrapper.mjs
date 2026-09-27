#!/usr/bin/env node
// A second, independent bus for another project: the same CLI with its own home and root.
// Lanes on this bus never see lanes on the default bus, and vice versa.
//
// Copy this file to e.g. ~/.claude/fleet-myproject/fleet.mjs, set the paths below, and point that
// project's hooks at this wrapper instead of the shared fleet.mjs.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
process.env.FLEET_HOME = path.dirname(self);          // this folder holds the bus's lanes and messages
process.env.FLEET_ROOT = '/path/to/my-other-project';  // folders under here auto-become lanes
process.env.FLEET_SELF = self;                         // "arm your listener" hints re-enter through this wrapper
await import(pathToFileURL(path.join(process.env.HOME || process.env.USERPROFILE, '.fleet-bus', 'fleet.mjs')).href);
