import { plugin } from "bun";

plugin({
	name: "wasm-preload",
	setup(build) {
		build.onLoad({ filter: /\.wasm$/ }, async (args) => {
			const data = await Bun.file(args.path).arrayBuffer();
			const contents = `export default new Uint8Array(${JSON.stringify(Array.from(new Uint8Array(data)))})`;
			return {
				contents: contents,
				loader: "js",
			};
		});
	},
});
