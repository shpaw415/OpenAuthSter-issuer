declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*.wasm" {
	const content: string | ArrayBuffer | Uint8Array | WebAssembly.Module;
	export default content;
}
