/** The pending-next store on AsyncStorage (same store the offline queue uses). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPendingNextStore } from './pendingNext';

export const pendingNext = createPendingNextStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
});
