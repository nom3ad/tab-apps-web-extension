import type { Alpine } from 'alpinejs';


declare global {
    interface Window {
        Alpine: Alpine;
    }
    declare const Alpine: Alpine
}