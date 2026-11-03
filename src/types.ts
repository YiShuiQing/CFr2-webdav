export interface Env {
  BUCKET: R2Bucket;
  USERNAME?: string;
  PASSWORD?: string;
  BUCKET_NAME?: string;
  CORS_ORIGINS?: string;
  MAX_UPLOAD_BYTES?: string;
  MAX_LIST_ITEMS?: string;
}

export interface WebDAVProps {
  creationdate: string;
  displayname: string | undefined;
  getcontentlanguage: string | undefined;
  getcontentlength: string;
  getcontenttype: string | undefined;
  getetag: string | undefined;
  getlastmodified: string;
  resourcetype: string;
}
