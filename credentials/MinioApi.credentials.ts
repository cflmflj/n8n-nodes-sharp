import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class MinioApi implements ICredentialType {
	name = 'minioApi';
	displayName = 'MinIO API';
	documentationUrl = 'https://min.io/docs/';

	properties: INodeProperties[] = [
		{
			displayName: 'End Point',
			name: 'endPoint',
			type: 'string',
			default: '127.0.0.1',
			description: 'Hostname or IP of the MinIO/S3 endpoint (without scheme)'
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 9000,
			description: 'Port of the MinIO/S3 endpoint'
		},
		{
			displayName: 'Use SSL',
			name: 'useSSL',
			type: 'boolean',
			default: false,
			description: 'Whether to use HTTPS (SSL) when connecting to the endpoint'
		},
		{
			displayName: 'Access Key',
			name: 'accessKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description: 'Access key (AK) for MinIO/S3'
		},
		{
			displayName: 'Secret Key',
			name: 'secretKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description: 'Secret key (SK) for MinIO/S3'
		},
	];
}


