/**
 * Reemplazo de Alert.alert basado en Modal con supportedOrientations={['portrait']}.
 *
 * Por qué: en iOS, Alert.alert de React Native abre su propio UIWindow con un UIViewController común
 * (React/CoreModules/RCTAlertController.mm). Mientras el cartel está visible, esa ventana es la key
 * window y expo-screen-orientation calcula la máscara de la app desde su rootViewController, que no
 * tiene ningún bloqueo: permite landscape, y si el teléfono quedó en horizontal el cartel gira.
 * Un Modal, en cambio, se presenta sobre la ventana principal, cuya máscara sí está bloqueada, y
 * además declara sólo portrait.
 *
 * Uso: installAppAlert() una vez al arrancar (reemplaza Alert.alert con la misma firma) y un
 * <AppAlertHost /> montado una vez en la raíz, dentro del ThemeProvider.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  type AlertButton,
  type AlertOptions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type AlertItem = {
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
};

/** Cola de carteles: el primero es el que está abierto. */
const queue: AlertItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function enqueue(item: AlertItem): void {
  queue.push(item);
  emit();
}

/** Cierra el cartel abierto (el siguiente de la cola, si hay, pasa a mostrarse). */
function closeCurrent(): void {
  queue.shift();
  emit();
}

let installed = false;
let originalAlert: typeof Alert.alert | null = null;

/** Reemplaza Alert.alert por la versión basada en Modal. Idempotente. */
export function installAppAlert(): void {
  if (installed) return;
  installed = true;
  originalAlert = Alert.alert;
  const replacement = (
    title: string,
    message?: string,
    buttons?: AlertButton[],
    options?: AlertOptions
  ): void => {
    enqueue({
      title,
      message: message ?? undefined,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }],
      options,
    });
  };
  (Alert as unknown as { alert: typeof replacement }).alert = replacement;
}

/** Restaura el Alert.alert original (para pruebas). */
export function uninstallAppAlert(): void {
  if (!installed || !originalAlert) return;
  (Alert as unknown as { alert: typeof originalAlert }).alert = originalAlert;
  installed = false;
}

export function AppAlertHost() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [, force] = useState(0);

  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const current: AlertItem | undefined = queue[0];

  const onPressButton = useCallback((button: AlertButton) => {
    // Primero se cierra este cartel y después corre el handler (que puede abrir otro: queda en cola).
    closeCurrent();
    button.onPress?.();
  }, []);

  const onBackdrop = useCallback(() => {
    if (!current?.options?.cancelable) return;
    const { onDismiss } = current.options;
    closeCurrent();
    onDismiss?.();
  }, [current]);

  if (!current) return null;

  const stacked = current.buttons.length > 2;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      supportedOrientations={['portrait']}
      statusBarTranslucent
      onRequestClose={onBackdrop}
    >
      <Pressable style={styles.backdrop} onPress={onBackdrop}>
        {/* El Pressable interno evita que tocar la tarjeta cierre el cartel. */}
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{current.title}</Text>
          {current.message ? (
            <ScrollView style={styles.messageScroll}>
              <Text style={styles.message}>{current.message}</Text>
            </ScrollView>
          ) : null}
          <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
            {current.buttons.map((b, i) => {
              const isCancel = b.style === 'cancel';
              const isDestructive = b.style === 'destructive';
              return (
                <TouchableOpacity
                  key={`${b.text ?? 'btn'}-${i}`}
                  style={[
                    styles.button,
                    !stacked && styles.buttonFlex,
                    i > 0 && !stacked && styles.buttonSep,
                    i > 0 && stacked && styles.buttonSepStacked,
                  ]}
                  activeOpacity={0.6}
                  onPress={() => onPressButton(b)}
                >
                  <Text
                    style={[
                      styles.buttonText,
                      isCancel && styles.buttonTextBold,
                      isDestructive && { color: colors.status.error.solid },
                    ]}
                  >
                    {b.text ?? 'OK'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    card: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: c.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderStrong,
      overflow: 'hidden',
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 6,
    },
    messageScroll: { maxHeight: 240, paddingHorizontal: 20 },
    message: { fontSize: 14, color: c.textBody, textAlign: 'center', paddingBottom: 4 },
    buttons: {
      flexDirection: 'row',
      marginTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.divider,
    },
    buttonsStacked: { flexDirection: 'column' },
    button: {
      paddingVertical: 13,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonFlex: { flex: 1 },
    buttonSep: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.divider },
    buttonSepStacked: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider },
    buttonText: { fontSize: 16, color: c.accent },
    buttonTextBold: { fontWeight: '700' },
  });
}
