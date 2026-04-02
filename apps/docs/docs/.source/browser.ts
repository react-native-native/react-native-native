// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "getting-started/hello-world.mdx": () => import("../content/docs/getting-started/hello-world.mdx?collection=docs"), "getting-started/installation.mdx": () => import("../content/docs/getting-started/installation.mdx?collection=docs"), "getting-started/production.mdx": () => import("../content/docs/getting-started/production.mdx?collection=docs"), "guides/cpp.mdx": () => import("../content/docs/guides/cpp.mdx?collection=docs"), "guides/kotlin.mdx": () => import("../content/docs/guides/kotlin.mdx?collection=docs"), "guides/objc.mdx": () => import("../content/docs/guides/objc.mdx?collection=docs"), "guides/rust.mdx": () => import("../content/docs/guides/rust.mdx?collection=docs"), }),
};
export default browserCollections;