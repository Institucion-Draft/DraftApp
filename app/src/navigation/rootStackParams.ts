import type { NavigatorScreenParams } from '@react-navigation/native';
import type { MainStackParamList } from './mainStackParams';

export type RootStackParamList = {
  Welcome: undefined;
  Auth: undefined;
  Main: NavigatorScreenParams<MainStackParamList> | undefined;
};
