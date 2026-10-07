/**
 * Política de orientación de la app: vertical, salvo las pantallas que piden landscape (el cuadro de
 * la Copa en StandingsScreen y LifeChartScreen). Ellas piden y sueltan landscape con
 * requestLandscape / releaseLandscape (que esperan el lockAsync) y la guarda global
 * (startPortraitGuard, montada en la raíz) corrige cualquier landscape que llegue mientras nadie lo
 * haya pedido.
 *
 * Por qué hace falta la guarda: en iOS, Alert.alert de React Native abre su propio UIWindow con un
 * UIViewController común (React/CoreModules/RCTAlertController.mm). Mientras el cartel está visible,
 * esa ventana pasa a ser la key window y expo-screen-orientation calcula la máscara de la app desde
 * su rootViewController (ScreenOrientationAppDelegate → registry.currentOrientationMask), que no
 * tiene ningún bloqueo: permite landscape. Si el teléfono quedó físicamente en horizontal (por
 * ejemplo después de ver el cuadro), el cartel gira a landscape y vuelve a vertical al cerrarse.
 */
import * as ScreenOrientation from 'expo-screen-orientation';

/** Cantidad de pantallas que hoy piden landscape (puede haber dos Standings apiladas un instante). */
let landscapeOwners = 0;

export function isLandscapeRequested(): boolean {
  return landscapeOwners > 0;
}

/** Pide landscape y espera a que el sistema lo aplique. */
export async function requestLandscape(): Promise<void> {
  landscapeOwners += 1;
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
  } catch (e) {
    if (__DEV__) console.warn('[orientation] no se pudo bloquear landscape', e);
  }
}

/** Suelta el pedido de landscape; cuando no queda ninguno, vuelve a vertical (y espera). */
export async function releaseLandscape(): Promise<void> {
  landscapeOwners = Math.max(0, landscapeOwners - 1);
  if (landscapeOwners > 0) return;
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch (e) {
    if (__DEV__) console.warn('[orientation] no se pudo volver a vertical', e);
  }
}

function isLandscape(o: ScreenOrientation.Orientation): boolean {
  return o === ScreenOrientation.Orientation.LANDSCAPE_LEFT || o === ScreenOrientation.Orientation.LANDSCAPE_RIGHT;
}

/**
 * Guarda global: si llega una orientación landscape y ninguna pantalla la pidió, fuerza vertical.
 * Devuelve la función que la desmonta.
 */
export function startPortraitGuard(): () => void {
  const subscription = ScreenOrientation.addOrientationChangeListener((event) => {
    if (isLandscapeRequested()) return;
    if (!isLandscape(event.orientationInfo.orientation)) return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  });
  return () => ScreenOrientation.removeOrientationChangeListener(subscription);
}
