import { reactive } from 'vue';

export type UploadedEntry = {
  path: string;
  url?: string;
  isImage: boolean;
  isDDS: boolean;
  file?: File;
};

interface FilesState {
  uploadedFiles: UploadedEntry[];
  expandedSet: Set<string>; // legacy, will be removed
  expanded: Record<string, boolean>;
  selectedPath: string | null;
}

export const filesState = reactive<FilesState>({
  uploadedFiles: [],
  expandedSet: new Set<string>(), // legacy, not used by new explorer
  expanded: {},
  selectedPath: null,
});

export function resetFilesState() {
  filesState.uploadedFiles = [];
  filesState.expandedSet = new Set<string>();
  filesState.expanded = {};
  filesState.selectedPath = null;
}
