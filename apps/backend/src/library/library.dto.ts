export interface LibraryFileDto {
  file_id: string;
  workspace_id: string;
  title: string;
  file_type: string;
  size: number;
  parse_status: string;
  error_message: string;
}
