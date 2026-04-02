// @ts-nocheck
import * as __fd_glob_8 from "../content/docs/guides/rust.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/guides/objc.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/guides/kotlin.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/guides/cpp.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/getting-started/production.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/getting-started/installation.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/getting-started/hello-world.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/index.mdx?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, }, {"index.mdx": __fd_glob_1, "getting-started/hello-world.mdx": __fd_glob_2, "getting-started/installation.mdx": __fd_glob_3, "getting-started/production.mdx": __fd_glob_4, "guides/cpp.mdx": __fd_glob_5, "guides/kotlin.mdx": __fd_glob_6, "guides/objc.mdx": __fd_glob_7, "guides/rust.mdx": __fd_glob_8, });