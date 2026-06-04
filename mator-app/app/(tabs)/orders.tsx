// app/(tabs)/orders.tsx — Cart & Orders screen (container)
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function OrdersScreen() {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Text style={styles.title}>{t('tabs.orders')}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5', paddingHorizontal: 16 },
  title: { fontSize: 28, fontWeight: '700', marginTop: 16 },
});
