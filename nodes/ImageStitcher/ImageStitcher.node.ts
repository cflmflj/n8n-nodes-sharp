import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import * as Minio from 'minio';
import type sharp from 'sharp';

type Alignment = 'left' | 'center' | 'right';

function parseBackgroundColor(input: string | undefined) {
	if (!input || input.toLowerCase() === 'transparent') {
		return { r: 0, g: 0, b: 0, alpha: 0 } as const;
	}
	const hex = input.replace('#', '').trim();
	if (hex.length === 6 || hex.length === 8) {
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
		return { r, g, b, alpha: a } as const;
	}
	return { r: 255, g: 255, b: 255, alpha: 1 } as const;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

export class ImageStitcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Image Stitcher',
		name: 'imageStitcher',
		group: ['transform'],
		version: 1,
		description: 'Stitch images vertically from MinIO and optionally upload the result back to MinIO',
		defaults: {
			name: 'Image Stitcher',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'minioApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Source Bucket',
				name: 'sourceBucket',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'Source Keys',
				name: 'sourceKeys',
				type: 'string',
				default: '',
				placeholder: 'key1.png\nkey2.jpg',
				description: 'Enter one key per line or comma-separated. Order determines the stitch order (top to bottom).',
				typeOptions: {
					rows: 5,
				},
				required: true,
			},
			{
				displayName: 'Spacing (Px)',
				name: 'spacing',
				type: 'number',
				default: 0,
				description: 'Vertical spacing between images in pixels',
			},
			{
				displayName: 'Horizontal Alignment',
				name: 'alignment',
				type: 'options',
				options: [
					{ name: 'Left', value: 'left' },
					{ name: 'Center', value: 'center' },
					{ name: 'Right', value: 'right' },
				],
				default: 'left',
			},
			{
				displayName: 'Normalize Width',
				name: 'normalizeWidth',
				type: 'boolean',
				default: true,
				description: 'Whether to resize all images to the same width to avoid side gaps',
			},
			{
				displayName: 'Target Width',
				name: 'targetWidth',
				type: 'number',
				default: 0,
				description: 'If > 0, use this width; otherwise the widest image width is used',
				displayOptions: {
					show: { normalizeWidth: [true] },
				},
			},
			{
				displayName: 'Allow Upscale',
				name: 'allowUpscale',
				type: 'boolean',
				default: true,
				description: 'Whether to allow enlarging smaller images to the target width',
				displayOptions: {
					show: { normalizeWidth: [true] },
				},
			},
			{
				displayName: 'Background Color',
				name: 'backgroundColor',
				type: 'color',
				default: 'transparent',
				description: 'Hex color like #RRGGBB or #RRGGBBAA, or "transparent"',
			},
			{
				displayName: 'Output Format',
				name: 'format',
				type: 'options',
				options: [
					{ name: 'PNG', value: 'png' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'WEBP', value: 'webp' },
				],
				default: 'png',
			},
			{
				displayName: 'Quality',
				name: 'quality',
				type: 'number',
				default: 80,
				description: 'Quality for JPEG/WEBP output (1-100)',
				displayOptions: {
					show: {
						format: ['jpeg', 'webp'],
					},
				},
			},
			{
				displayName: 'Destination Bucket',
				name: 'destinationBucket',
				type: 'string',
				default: '',
				description: 'If set, the stitched image will be uploaded to this bucket',
			},
			{
				displayName: 'Destination Key',
				name: 'destinationKey',
				type: 'string',
				default: '',
				description: 'If set, the stitched image will be uploaded under this key',
			},
			{
				displayName: 'Also Output Binary',
				name: 'outputBinary',
				type: 'boolean',
				default: true,
				description: 'Whether to also attach the stitched image as binary data to the node output',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						outputBinary: [true],
					},
				},
				description: 'Binary property name to store the stitched image',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = (await this.getCredentials('minioApi')) as {
			endPoint: string;
			port: number;
			useSSL: boolean;
			accessKey: string;
			secretKey: string;
		};

		const minioClient = new Minio.Client({
			endPoint: credentials.endPoint,
			port: Number(credentials.port),
			useSSL: Boolean(credentials.useSSL),
			accessKey: credentials.accessKey,
			secretKey: credentials.secretKey,
		});

		// Lazy-load sharp to avoid failing community package load at startup
		const { default: sharp } = await import('sharp');

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const sourceBucket = this.getNodeParameter('sourceBucket', itemIndex, '') as string;
				const sourceKeysParam = this.getNodeParameter('sourceKeys', itemIndex, '') as unknown;
				const spacing = this.getNodeParameter('spacing', itemIndex, 0) as number;
				const alignment = this.getNodeParameter('alignment', itemIndex, 'left') as Alignment;
				const normalizeWidth = this.getNodeParameter('normalizeWidth', itemIndex, true) as boolean;
				const targetWidthParam = this.getNodeParameter('targetWidth', itemIndex, 0) as number;
				const allowUpscale = this.getNodeParameter('allowUpscale', itemIndex, true) as boolean;
				const backgroundColor = this.getNodeParameter('backgroundColor', itemIndex, 'transparent') as string;
				const format = this.getNodeParameter('format', itemIndex, 'png') as 'png' | 'jpeg' | 'webp';
				const quality = this.getNodeParameter('quality', itemIndex, 80) as number;
				const destinationBucket = this.getNodeParameter('destinationBucket', itemIndex, '') as string;
				const destinationKey = this.getNodeParameter('destinationKey', itemIndex, '') as string;
				const outputBinary = this.getNodeParameter('outputBinary', itemIndex, true) as boolean;
				const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;

				let keys: string[] = [];
				if (Array.isArray(sourceKeysParam)) {
					keys = sourceKeysParam
						.map((k) => String(k))
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
				} else if (typeof sourceKeysParam === 'string') {
					keys = sourceKeysParam
						.split(/\r?\n|,/)
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
				} else if (
					sourceKeysParam &&
					typeof sourceKeysParam === 'object' &&
					Array.isArray((sourceKeysParam as any).keys)
				) {
					// Fallback: if an object with a `keys` array was provided
					keys = (sourceKeysParam as any).keys
						.map((k: unknown) => String(k))
						.map((s: string) => s.trim())
						.filter((s: string) => s.length > 0);
				} else if (sourceKeysParam != null) {
					// Last resort: coerce to string and parse
					keys = String(sourceKeysParam)
						.split(/\r?\n|,/)
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
				}

				if (!sourceBucket) {
					throw new NodeOperationError(this.getNode(), 'Source bucket is required', { itemIndex });
				}
				if (keys.length === 0) {
					throw new NodeOperationError(this.getNode(), 'At least one source key is required', { itemIndex });
				}

				const imageBuffers: Buffer[] = [];
				const dimensions: { width: number; height: number }[] = [];
				for (const key of keys) {
					const stream = await minioClient.getObject(sourceBucket, key);
					const buffer = await streamToBuffer(stream);
					const meta = await sharp(buffer).metadata();
					if (!meta.width || !meta.height) {
						throw new NodeOperationError(this.getNode(), `Could not read image metadata for key: ${key}`, { itemIndex });
					}
					imageBuffers.push(buffer);
					dimensions.push({ width: meta.width, height: meta.height });
				}

				// Determine target width and optionally normalize image widths
				let canvasWidth = Math.max(...dimensions.map((d) => d.width));
				const targetWidth = normalizeWidth
					? (targetWidthParam && targetWidthParam > 0 ? targetWidthParam : canvasWidth)
					: canvasWidth;

				if (normalizeWidth) {
					for (let i = 0; i < imageBuffers.length; i++) {
						if (dimensions[i].width !== targetWidth) {
							const { data, info } = await sharp(imageBuffers[i])
								.resize({ width: targetWidth, withoutEnlargement: !allowUpscale })
								.toBuffer({ resolveWithObject: true });
							imageBuffers[i] = data;
							dimensions[i] = { width: info.width, height: info.height };
						}
					}
					canvasWidth = targetWidth;
				}

				const canvasHeight = dimensions.reduce((acc, d) => acc + d.height, 0) + Math.max(0, (keys.length - 1) * spacing);

				const bg = parseBackgroundColor(backgroundColor);
				const canvas = sharp({
					create: {
						width: canvasWidth,
						height: canvasHeight,
						channels: 4,
						background: bg,
					},
				});

				let offsetTop = 0;
				const composites: sharp.OverlayOptions[] = [];
				for (let i = 0; i < imageBuffers.length; i++) {
					const { width, height } = dimensions[i];
					let left = 0;
					if (alignment === 'center') {
						left = Math.floor((canvasWidth - width) / 2);
					} else if (alignment === 'right') {
						left = canvasWidth - width;
					}
					composites.push({ input: imageBuffers[i], top: offsetTop, left });
					offsetTop += height + (i < imageBuffers.length - 1 ? spacing : 0);
				}

				let pipeline = canvas.composite(composites);
				let mimeType = 'image/png';
				if (format === 'png') {
					pipeline = pipeline.png();
					mimeType = 'image/png';
				} else if (format === 'jpeg') {
					pipeline = pipeline.jpeg({ quality });
					mimeType = 'image/jpeg';
				} else if (format === 'webp') {
					pipeline = pipeline.webp({ quality });
					mimeType = 'image/webp';
				}

				const outBuffer = await pipeline.toBuffer();

				let uploaded: { etag?: string } | undefined;
				if (destinationBucket && destinationKey) {
					uploaded = await minioClient.putObject(destinationBucket, destinationKey, outBuffer, outBuffer.length, {
						'Content-Type': mimeType,
					});
				}

				const newItem: INodeExecutionData = { json: {} };
				newItem.json = {
					sourceBucket,
					sourceKeys: keys,
					canvas: { width: canvasWidth, height: canvasHeight },
					uploaded: destinationBucket && destinationKey ? { bucket: destinationBucket, key: destinationKey, etag: uploaded?.etag } : undefined,
				};

				if (outputBinary) {
					newItem.binary = newItem.binary ?? {};
					const fileName = destinationKey || `stitched.${format}`;
					newItem.binary[binaryPropertyName] = {
						data: outBuffer.toString('base64'),
						mimeType,
						fileName,
					};
				}

				returnData.push(newItem);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: itemIndex });
					continue;
				}
				if ((error as any).context) {
					(error as any).context.itemIndex = itemIndex;
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}


