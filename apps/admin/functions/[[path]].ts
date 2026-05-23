import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';
// @ts-expect-error virtual module emitted by Remix build
import * as build from '../build/server';

export const onRequest = createPagesFunctionHandler({ build });
